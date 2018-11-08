#!/bin/node

const commandLineArgs = require("command-line-args");
const beautify = require("js-beautify").js_beautify;
const Sequelize = require("sequelize");

const migrate = require("../lib/migrate");

const path = require('path');
const _ = require('lodash');
const fs = require('fs');

const optionDefinitions = [
  {
    name: "preview",
    alias: "p",
    type: Boolean,
    description: "Show migration preview (does not change any files)"
  },
  {
    name: "name",
    alias: "n",
    type: String,
    description: 'Set migration name (default: "noname")'
  },
  {
    name: "comment",
    alias: "c",
    type: String,
    description: "Set migration comment"
  },
  {
    name: "execute",
    alias: "x",
    type: Boolean,
    description: "Create new migration and execute it"
  },
  {
    name: "migrations-path",
    type: String,
    description: "The path to the migrations folder"
  },
  {
    name: "models-path",
    type: String,
    description: "The path to the models folder"
  },
  {
    name: "verbose",
    alias: "v",
    type: Boolean,
    description: "Show details about the execution"
  },
  {
    name: "debug",
    alias: "d",
    type: Boolean,
    description: "Show error messages to debug problems"
  },
  {
    name: "keep-files",
    alias: "k",
    type: Boolean,
    description:
      "Don't delete previous files from the current revision (requires a unique --name option for each file)"
  },
  {
    name: "help",
    alias: "h",
    type: Boolean,
    description: "Show this message"
  },
  {
    name: "migration-table-name",
    alias: "m",
    type: String,
    description: "Sequelize Migration Storage table name"
  }
];

const options = commandLineArgs(optionDefinitions);

if (options.help) {
  console.log("Sequelize migration creation tool\n\nUsage:");
  optionDefinitions.forEach(option => {
    const alias = option.alias ? ` (-${option.alias})` : "\t";
    console.log(`\t --${option.name}${alias} \t${option.description}`);
  });
  process.exit(0);
}


const rcFileResolved = path.resolve(process.cwd(), '.sequelizerc');
const rcOptions = fs.existsSync(rcFileResolved) ? JSON.parse(JSON.stringify(require(rcFileResolved))) : {};

options['models-path'] = options['models-path'] || rcOptions['models-path'] ||  '';
options['migrations-path'] = options['migrations-path'] || rcOptions['migrations-path'] || '';

const sequelizeConfig = fs.existsSync(rcOptions['config']) ? JSON.parse(JSON.stringify(require(rcOptions['config']))) : {};
const sequelizeEnvConfig = sequelizeConfig[process.env.NODE_ENV || 'development'] || {};
options['migration-table-name'] = options['migration-table-name'] || sequelizeEnvConfig['migrationStorageTableName'];

const migrationsDir = path.resolve(process.cwd(), options['migrations-path']); 
const modelsDir = path.resolve(process.cwd(), options['models-path']);  

// current state
const currentState = {
  tables: {}
};

// load last state
let previousState = {
  revision: 0,
  version: 1,
  tables: {}
};

const {
  sequelize
} = require(modelsDir); /* eslint import/no-dynamic-require: off */

if (!options.debug) sequelize.options.logging = false;

const queryInterface = require(modelsDir).sequelize.getQueryInterface();
const { models } = sequelize;

// This is the table that sequelize uses
queryInterface
  .createTable(options["migration-table-name"], {
    name: {
      type: Sequelize.STRING,
      allowNull: false,
      unique: true,
      primaryKey: true
    }
  })
  .then(() => {
    // We get the state at the last migration executed
    return sequelize
      .query(
        "SELECT name FROM " +
          options["migration-table-name"] +
          " ORDER BY name desc limit 1",
        { type: sequelize.QueryTypes.SELECT }
      )
      .then(([lastExecutedMigration]) => {
        try {
          const previousStateFilename = `${path.basename(
            lastExecutedMigration,
            path.extname(lastExecutedMigration)
          )}.json`;
          previousState = JSON.parse(
            fs.readFileSync(path.join(migrationsDir, previousStateFilename))
          );
        } catch (e) {}

        currentState.tables = migrate.reverseModels(sequelize, models);

        const actions = migrate.parseDifference(
          previousState.tables,
          currentState.tables
        );

        const downActions = migrate.parseDifference(
          currentState.tables,
          previousState.tables
        );

        // sort actions
        migrate.sortActions(actions);
        migrate.sortActions(downActions);

        const migration = migrate.getMigration(actions);
        const tmp = migrate.getMigration(downActions);

        migration.commandsDown = tmp.commandsUp;

        if (migration.commandsUp.length === 0) {
          console.log("No changes found");
          process.exit(0);
        }

        // log migration actions
        _.each(migration.consoleOut, v => {
          console.log(`[Actions] ${v}`);
        });

        if (options.preview) {
          console.log("Migration result:");
          console.log(
            beautify(`[ \n${migration.commandsUp.join(", \n")} \n];\n`)
          );
          console.log("Undo commands:");
          console.log(
            beautify(`[ \n${migration.commandsDown.join(", \n")} \n];\n`)
          );
          process.exit(0);
        }

        // Bump revision
        currentState.revision = previousState.revision + 1;

        migrate
          .pruneOldMigFiles(currentState.revision, migrationsDir, options)
          .then(() => {
            // write migration to file
            const info = migrate.writeMigration(
              currentState.revision,
              migration,
              migrationsDir,
              options.name ? options.name : "noname",
              options.comment ? options.comment : ""
            );

            console.log(
              `New migration to revision ${
                currentState.revision
              } has been saved to file '${info.filename}'`
            );

            // save current state
            // Ugly hack, see https://github.com/sequelize/sequelize/issues/8310
            const rows = [
              {
                revision: currentState.revision,
                name: info.info.name,
                state: JSON.stringify(currentState)
              }
            ];

            const currentStateFilename = `${path.basename(
              info.filename,
              path.extname(info.filename)
            )}.json`;
            fs.writeFileSync(
              path.join(path.dirname(info.filename), currentStateFilename),
              JSON.stringify(currentState, null, 4)
            );

            if (options.verbose) console.log("Updated state.");
            if (options.execute) {
              console.log(`Use sequelize CLI: 
                       sequelize db:migrate --to ${currentState.revision}-${
                info.info.name
              } ${
                options["migrations-path"]
                  ? `--migrations-path=${options["migrations-path"]}`
                  : ""
              } ${
                options["models-path"]
                  ? `--models-path=${options["models-path"]}`
                  : ""
              }`);
              process.exit(0);
            } else {
              process.exit(0);
            }
          });
      })
      .catch(err => {
        if (options.debug) console.error(err);
      });
  })
  .catch(err => {
    if (options.debug) console.error(err);
  });
