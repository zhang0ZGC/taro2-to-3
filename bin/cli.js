#! /usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const execa = require('execa');
const isGitClean = require('is-git-clean');
const readPkgUp = require('read-pkg-up');
const Table = require('cli-table');
const inquirer = require('inquirer');
const semverSatisfies = require('semver/functions/satisfies');
const jscodeshiftBin = require.resolve('.bin/jscodeshift');
const ejs = require('ejs');

const taroDeps = require('./taroDeps');
const marker = require('../transforms/utils/marker');

const transformersDir = path.join(__dirname, '../transforms');
const Project = require('./project');

// override default babylon parser config to enable `decorator-legacy`
// https://github.com/facebook/jscodeshift/blob/master/parser/babylon.js
const babylonConfig = path.join(__dirname, './babylon.config.json');

const transformers = [
  'router',
  'taro-imports',
  'page-config'
];

const dependencyProperties = [
  'dependencies',
  'devDependencies',
  'clientDependencies',
  'isomorphicDependencies',
  'buildDependencies'
];

const tableChars = {
  top: '',
  'top-mid': '',
  'top-left': '',
  'top-right': '',
  bottom: '',
  'bottom-mid': '',
  'bottom-left': '',
  'bottom-right': '',
  left: '',
  'left-mid': '',
  mid: '',
  'mid-mid': '',
  right: '',
  'right-mid': '',
  middle: ''
};

async function ensureGitClean() {
  let clean = false;
  try {
    clean = await isGitClean();
  } catch (err) {
    if (err && err.stderr && err.stderr.toLowerCase().includes('not a git repository')) {
      clean = true;
    }
  }

  if (!clean) {
    console.log(chalk.yellow('Sorry that there are still some git changes'));
    console.log('\n you must commit or stash them firstly');
    process.exit(1);
  }
}

function getRunnerArgs(
  transformerPath,
  parser = 'babylon', // use babylon as default parser
  options = {}
) {
  const args = [
    '--verbose=2',
    '--ignore-pattern=**/node_modules',
    '--quote=single'
  ];

  // limit usage for cpus
  const cpus = options.cpus || Math.max(2, Math.ceil(os.cpus().length / 3));
  args.push('--cpus', cpus);

  // https://github.com/facebook/jscodeshift/blob/master/src/Runner.js#L255
  // https://github.com/facebook/jscodeshift/blob/master/src/Worker.js#L50
  args.push('--no-babel');

  args.push('--parser', parser);

  args.push('--parser-config', babylonConfig);
  args.push('--extensions=tsx,ts,jsx,js');

  args.push('--transform', transformerPath);

  if (options.gitignore) {
    args.push('--ignore-config', options.gitignore);
  }

  if (options.style) {
    args.push('--importStyles');
  }

  if (options.pages) {
    args.push(`--pages=${options.pages}`);
  }
  return args;
}

async function run(filePath, args = {}) {
  for (const transformer of transformers) {
    await transform(transformer, 'babylon', filePath, args);
  }
}

async function transform(transformer, parser, filePath, options) {
  console.log(chalk.bgGreen.bold('Transform'), transformer);
  const transformerPath = path.join(transformersDir, `${transformer}.js`);

  const args = [filePath].concat(
    getRunnerArgs(transformerPath, parser, options)
  );

  try {
    if (process.env.NODE_ENV === 'local') {
      console.log(`Running jscodeshift with: ${args.join(' ')}`);
    }
    await execa(jscodeshiftBin, args, {
      stdio: 'inherit',
      stripEof: false
    });
  } catch (err) {
    console.error(err);
    if (process.env.NODE_ENV === 'local') {
      const errorLogFile = path.join(__dirname, './error.log');
      fs.appendFileSync(errorLogFile, err);
      fs.appendFileSync(errorLogFile, '\n');
    }
  }
}

function renderBabelConfig(dependenciesMarkers) {
  return new Promise((resolve, reject) => {
    ejs.renderFile(
      path.join(__dirname, 'templates/babel.config.ejs'),
      {
        shouldUseConstEnumPlugin: dependenciesMarkers['babel-plugin-const-enum'] > 0
      },
      (err, str) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(str);
      }
    );
  });
}

async function checkBabelConfig(projectDir, dependenciesMarkers) {
  try {
    const projectBabelConfigPath = path.join(projectDir, 'babel.config.js');
    if (!fs.existsSync(projectBabelConfigPath)) {
      const source = await renderBabelConfig(dependenciesMarkers);
      await fs.writeFile(projectBabelConfigPath, source);
    }
  } catch (error) {
    console.log(chalk.red(error.message));
  }
}

async function checkDependencies(targetDir, dependenciesMarkers) {
  const cwd = path.join(process.cwd(), targetDir);
  const closetPkgJson = await readPkgUp({ cwd });

  if (!closetPkgJson) {
    console.log('We didn\'t find your package.json');
    return;
  }

  const { packageJson } = closetPkgJson;
  const upgradeDeps = Object.create(null);
  const deprecatedDeps = [];
  const installDeps = taroDeps.install;
  dependencyProperties.forEach(property => {
    const deps = packageJson[property];
    if (!deps) {
      return;
    }

    const expectVersion = '^3.1.1';
    const {deprecated, upgrade} = taroDeps;
    deprecated.forEach(depName => {
      if (deps[depName]) {
        deprecatedDeps.push(depName);
      }
    });
    upgrade.forEach(depName => {
      const versionRange = deps[depName];
      if (!!versionRange && !semverSatisfies(expectVersion, versionRange)) {
        upgradeDeps[depName] = [versionRange, expectVersion];
      }
    });
  });

  console.log('----------- taro dependencies alert -----------\n');
  console.log(
    chalk.yellow(
      'Should install/uninstall/upgrade these dependencies to ensure working well with taro3'
    )
  );

  const upgradeDepsTable = new Table({
    colAligns: ['left', 'right', 'right', 'right'],
    chars: tableChars
  });
  const additionsDepsTable = new Table({
    colAligns: ['left', 'right'],
    chars: tableChars
  });
  Object.keys(upgradeDeps).forEach(depName => {
    const [from, expect] = upgradeDeps[depName];
    upgradeDepsTable.push([depName, from, '→', expect]);
  });
  installDeps.forEach(({name, version}) => additionsDepsTable.push([name, version]));
  console.log('\n* Install\n');
  console.log(chalk.green(additionsDepsTable.toString()));
  console.log('\n* Upgrade\n');
  console.log(chalk.blue(upgradeDepsTable.toString()));
  console.log('\n* Uninstall\n');
  console.log(chalk.red(deprecatedDeps.join(os.EOL)));
  console.log('\n');

  const pkgs = Object.keys(upgradeDeps).map(depName => {
    const [, expect] = upgradeDeps[depName];
    return `${depName}@${expect}`;
  });

  const {theme} = await inquirer.prompt([{
    type: 'rawlist',
    name: 'theme',
    message: 'Do you need to install/uninstall/upgrade these dependencies automatically?',
    choices: [
      'Yes (use npm)',
      'Yes (use yarn)',
      'No'
    ]
  }]);

  let bin;
  if (theme === 'Yes (use npm)') {
    bin = 'npm';
  } else if (theme === 'Yes (use yarn)') {
    bin = 'yarn';
  }

  if (bin) {
    const installCommand = {'npm': 'install', 'yarn': 'add'}[bin];
    const uninstallCommand = {'npm': 'uninstall', 'yarn': 'remove'}[bin];
    const commonInstallDeps = installDeps.filter(d => !d.dev).map(d => d.name);
    console.log(chalk.gray(`\n> ${bin} ${installCommand} ${pkgs.concat(commonInstallDeps).join(' ')}\n`));
    await execa(bin, [installCommand, ...pkgs.concat(commonInstallDeps), '--registry','https://registry.npmmirror.com/'], {
      stdio: 'inherit',
      stripEof: false
    });

    const devInstallDeps = installDeps
      .filter(d => d.dev)
      .map(d => d.name)
      .concat(Object.keys(dependenciesMarkers));
    console.log(chalk.gray(`\n> ${bin} ${installCommand} -D ${devInstallDeps.join(' ')}\n`));
    await execa(bin, [installCommand, '-D', ...devInstallDeps, '--registry','https://registry.npmmirror.com/'], {
      stdio: 'inherit',
      stripEof: false
    });

    console.log(chalk.gray(`\n> ${bin} ${uninstallCommand} ${deprecatedDeps.join(' ')}\n`));
    await execa(bin, [uninstallCommand, ...deprecatedDeps], {
      stdio: 'inherit',
      stripEof: false
    });
  }
}

/**
 * options
 * --force   // force skip git checking (dangerously)
 * --cpus=1  // specify cpus cores to use
 */
async function bootstrap() {
  const args = require('yargs-parser')(process.argv.slice(3));
  if (process.env.NODE_ENV !== 'local') {
    // 检查 git 状态
    if (!args.force) {
      await ensureGitClean();
    } else {
      console.log(
        Array(3)
          .fill(1)
          .map(() =>
            chalk.yellow(
              'WARNING: You are trying to skip git status checking, please be careful'
            )
          )
          .join(os.EOL)
      );
    }
  }

  const projectDir = process.cwd();
  let project;
  try {
    project = new Project(projectDir);
  } catch (error) {
    console.log(chalk.red(error.message));
    process.exit(1);
  }
  project.transformAndOverwriteConfig();
  project.transformEntry();

  await marker.start();

  args.pages = project.pages.concat(`${project.sourceRoot}/app`).join(',');
  await run(project.sourceRoot, args);

  const dependenciesMarkers = await marker.output();
  await checkBabelConfig(projectDir, dependenciesMarkers);
  await checkDependencies(project.sourceRoot, dependenciesMarkers);

  console.log('\n----------- Thanks for using taro-2-to-3 -----------');
}

bootstrap();
