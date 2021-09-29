const process = require('process');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const mkdirp = require('mkdirp');
const os = require('os');
const electronInstaller = require('electron-winstaller');
const ncp = require('ncp').ncp;

var deleteRecursive = function(inPath) {
  // existsSync follows symlinks and crap, so just try to delete straight up first
  try {
    fs.unlinkSync(inPath);
  }
  catch (ignore) {
  }

  if (fs.existsSync(inPath) && fs.lstatSync(inPath).isDirectory()) {
    fs.readdirSync(inPath).forEach(function(file,index) {
      var curPath = path.join(inPath, file);
      deleteRecursive(curPath);
    });
    fs.rmdirSync(inPath);
  }
};

const buildPath = path.join(__dirname, 'build');
deleteRecursive(buildPath);
mkdirp.sync(buildPath);

var appDir;
var appId;
var runtimeId;
var assets;
for (var arg of process.argv) {
  if (arg.startsWith('--app-id=')) {
    appId = arg.substring('--app-id='.length)
  }
  else if (arg.startsWith('--app-dir=')) {
    appDir = path.resolve(arg.substring('--app-dir='.length))
  }
  else if (arg.startsWith('--runtime-id=')) {
    runtimeId = arg.substring('--runtime-id='.length)
  }
  else if (arg.startsWith('--assets=')) {
    assets = path.resolve(arg.substring('--assets='.length))
  }
}

if (!appDir) {
  console.error('missing --app-dir argument');
  console.error('example: --app-dir=/path/to/chrome/app')
  process.exit(-1);
}

var manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json')).toString());
var chrome;
try {
  chrome = JSON.parse(fs.readFileSync(path.join(appDir, 'electron.json')).toString());
}
catch (e) {
}

runtimeId = runtimeId || (chrome && chrome.runtimeId);

if (!runtimeId) {
  console.warn('missing --runtime-id')
  console.warn('Chrome runtime will only be updated with full electron upgrades.')
  console.warn('');
}
else {
  console.log(`chrome runtime id ${runtimeId}`)
  console.log();
}

function withAppId() {
  // grab largest
  var key = Object.keys(manifest.icons).sort((a,b) => parseInt(a) < parseInt(b))[0].toString();
  var icon = path.join(appDir, manifest.icons[key]);
  var iconScript = null;
  if (os.platform() == 'win32')
    iconScript = 'icon.bat';
  else
    iconScript = './icon.sh';

  if (iconScript) {
    console.log(iconScript);
    var child = require('child_process').exec(`${iconScript} ${icon}`);
    child.stdout.pipe(process.stdout)
    child.on('exit', function() {
      console.log('icon creation done')
      startPackager();
    })
    child.on('error', function() {
      console.error(arguments);
    })
  }
  else {
    startPackager();
  }
}

const platformIconExtensions = {
  win32: '.ico',
  darwin: '.icns',
  linux: '.png',
}

const platformIcon = path.join(process.cwd(), 'build/icon' + platformIconExtensions[os.platform()]);

function createPackageJson(inputPackageJson, outputPackageJson) {
  var electronJson = inputPackageJson;
  var electronPackage = JSON.parse(fs.readFileSync(electronJson).toString());
  electronPackage.name = manifest.name;
  electronPackage.description = manifest.description;
  electronPackage.version = manifest.version;
  electronPackage.build = {
    asar: false,
  }
  chrome = chrome || {};
  chrome.runtimeId = chrome.runtimeId || runtimeId;
  chrome.appId = chrome.appId || appId;
  electronPackage.chrome = chrome;
  fs.writeFileSync(outputPackageJson, JSON.stringify(electronPackage, null, 2));
}

var ncpp = require('deferred').promisify(ncp);
var ncpOpts = {
  clobber: false,
  dereference: true,
};

async function startLinuxPackager() {
  console.log('linux');
  var buildPath = path.join(__dirname, 'build');
  mkdirp.sync(buildPath);
  for (var f of ['electron-main.js', 'electron-background.html', 'package.json', 'node_modules', 'chrome']) {
    await ncpp(path.join(__dirname, f), path.join(buildPath, f), ncpOpts);
  }
  await ncpp(appDir, path.join(buildPath, 'unpacked-crx'), ncpOpts);

  if (assets) {
    var platformAssets = path.join(assets, os.platform());
    var platformAssetsDest = path.join(buildPath, 'platform-assets', os.platform());
    mkdirp.sync(platformAssetsDest);
    await ncpp(platformAssets, platformAssetsDest, ncpOpts);
  }
  else {
    console.log('no assets');
  }

  createPackageJson(path.join(buildPath, 'package.json'), path.join(buildPath, 'package.json'));
}

function startPackager() {
  if (process.env['TARGET_PLATFORM'] == 'linux') {
    return startLinuxPackager();
  }

  var packager = require('electron-packager')
  var out = path.join(__dirname, 'build');
  packager({
    dir: __dirname,
    out: out,
    platform: os.platform(),
    arch: 'all',

    name: manifest.name,
    icon: platformIcon,
    appVersion: manifest.version,
    buildVersion: manifest.version,
    appCopyright: 'Copyright ' + (manifest.author || manifest.name),
    overwrite: true,

    // windows file details (needed for shortcut and stuff)
    win32metadata: {
      CompanyName: manifest.author || manifest.name,
      FileDescription: manifest.name,
      ProductName: manifest.name,
      InternalName: manifest.name,
    },

    // mac signing and url handler
    osxSign: true,
    protocols: [
      {
        name: manifest.name,
        schemes: [ `ec-${appId}` ]
      }
    ],

    // all: true,
    afterCopy: [function(buildPath, electronVersion, platform, arch, callback) {

      console.log(appDir, buildPath);

      var packageJson = path.join(buildPath, 'package.json');
      createPackageJson(packageJson, packageJson);

      console.log('copying app into place');
      ncp(appDir, path.join(buildPath, 'unpacked-crx'), {
        clobber: false,
        dereference: true,
      },
      function (err) {
        if (err) {
          console.error(err);
          process.exit(-1);
        }
        console.log('app copied into place');
        if (!assets) {
          console.log('no assets');
          callback();
          return;
        }

        console.log('copying platform-assets into place for', os.platform());
        var platformAssets = path.join(assets, os.platform());
        var platformAssetsDest = path.join(buildPath, 'platform-assets', os.platform());
        mkdirp.sync(platformAssetsDest);
        ncp(platformAssets, platformAssetsDest, {
          clobber: false,
          dereference: true,
        }, function(err) {
          if (err) {
            console.error(err);
            process.exit(-1);
          }
          console.log('platform-assets copied into place');
          callback();
        })
      });
    }]
  }, function (err, appPaths) {
    console.log('making zips');
    if (err) {
      console.error(err);
      throw err;
    }
    function makeMacZip(appPath) {
      var child = require('child_process').spawn('zip', ['-ry', `${manifest.name}-mac.zip`, `${manifest.name}.app`], {
        cwd: appPath,
      });
      child.stdout.pipe(process.stdout);
      child.on('exit', function() {
        console.log('zip complete');
      })
    }

    appPaths
    .filter(appPath => appPath.indexOf('darwin') != -1)
    .forEach(appPath => {
      console.log(appPath);
      /*
      var infoPlist = path.join(appPath, manifest.name + '.app', 'Contents', 'Info.plist');
      console.log(infoPlist);
      var child = require('child_process').exec(`defaults write ${infoPlist} CFBundleURLTypes '<array><dict><key>CFBundleURLName</key><string>${manifest.name}</string><key>CFBundleURLSchemes</key><array><string>ec-${appId}</string></array></dict></array>'`)
      child.stdout.pipe(process.stdout);
      child.on('exit', function() {
        makeMacZip();
      })
      */
      makeMacZip(appPath);
    })

    appPaths
    .filter(appPath => appPath.indexOf('win32') != -1)
    .forEach(appPath => {
      var key = Object.keys(manifest.icons).sort((a,b) => parseInt(a) < parseInt(b))[0].toString();
      var icon = path.join(appDir, manifest.icons[key]);
      var iconUrl = 'file://' + icon.replace(/\\/g, '/').replace(':', '');

      iconUrl = 'file://' + path.join(process.cwd(), platformIcon).replace(/\\/g, '/').replace(':', '');
      console.log(iconUrl);

      var resultPromise = electronInstaller.createWindowsInstaller({
        appDirectory: appPath,
        outputDirectory: appPath + '-installer',
        authors: manifest.author || manifest.name,
        version: manifest.version,
        exe: manifest.name + '.exe',
        setupExe: path.basename(appPath) + '.exe',
        productName: manifest.name,
        title: manifest.name,
        name: manifest.name,
        iconUrl: iconUrl,
        description: manifest.description,
        noMsi: true,
      });

      resultPromise.then(() => console.log("Windows Intaller created."), (e) => { console.log(`Windows Installer failed: ${e.message}`); console.log(e); } );
    })

  })
}

function needAppId() {
  console.error('missing --app-id argument');
  console.error('example: --app-id=gidgenkbbabolejbgbpnhbimgjbffefm')
  process.exit(-1);
}

if (!appId) {
  if (!manifest.key) {
    needAppId();
    return;
  }
  require('./chrome/main/chrome-app-id.js').calculateId(manifest.key)
  .then(id => {
    appId = id;
    withAppId();
  })
  .catch(() => {
    needAppId();
  })
}
else {
  withAppId();
}
