'use strict';
// @ts-check

const fs = require('fs');
const helper = require('./chromedriver');
const axios = require('axios').default;
const mkdirp = require('mkdirp');
const path = require('path');
const del = require('del');
const child_process = require('child_process');
const os = require('os');
const url = require('url');
const https = require('https');
const extractZip = require('extract-zip');
const HttpsProxyAgent = require('https-proxy-agent');

const platform = validatePlatform();
const configuredfilePath = process.env.npm_config_chromedriver_filepath || process.env.CHROMEDRIVER_FILEPATH;
const detect_chromedriver_version = process.env.npm_config_detect_chromedriver_version || process.env.DETECT_CHROMEDRIVER_VERSION;
let downloadedFile = '';

function validatePlatform() {
    /** @type string */
    let thePlatform = process.platform;
    if (thePlatform === 'linux') {
        if (process.arch === 'arm64' || process.arch === 'x64') {
            thePlatform += '64';
        } else {
            console.log('Only Linux 64 bits supported.');
            process.exit(1);
        }
    } else if (thePlatform === 'darwin' || thePlatform === 'freebsd') {
        if (process.arch === 'x64') {
            thePlatform = 'mac64';
        } else {
            console.log('Only Mac 64 bits supported.');
            process.exit(1);
        }
    } else if (thePlatform !== 'win32') {
        console.log('Unexpected platform or architecture:', process.platform, process.arch);
        process.exit(1);
    }
    return thePlatform;
}

exports.downloadChromedriver = async function (cdnUrl, chromedriver_version, dirToLoadTo) {
    if (detect_chromedriver_version !== 'true' && configuredfilePath) {
        downloadedFile = configuredfilePath;
        console.log('Using file: ', downloadedFile);
        return;
    } else {
        const fileName = `chromedriver_${platform}.zip`;
        const tempDownloadedFile = path.resolve(dirToLoadTo, fileName);
        downloadedFile = tempDownloadedFile;
        const formattedDownloadUrl = `${cdnUrl}/${chromedriver_version}/${fileName}`;
        console.log('Downloading from file: ', formattedDownloadUrl);
        console.log('Saving to file:', downloadedFile);
        await exports.requestBinary(exports.getRequestOptions(formattedDownloadUrl), downloadedFile);
    }
}

exports.verifyIfChromedriverIsAvailableAndHasCorrectVersion = function (chromedriver_version) {
    let tmpPath = exports.findSuitableTempDirectory(chromedriver_version);
    let chromedriverBinaryFileName = process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver';
    let chromedriverBinaryFilePath = path.resolve(tmpPath, chromedriverBinaryFileName);
    if (!fs.existsSync(chromedriverBinaryFilePath))
        return Promise.resolve(false);
    console.log('ChromeDriver binary exists. Validating...');
    const deferred = new Deferred();
    try {
        fs.accessSync(chromedriverBinaryFilePath, fs.constants.X_OK);
        const cp = child_process.spawn(chromedriverBinaryFilePath, ['--version']);
        let str = '';
        cp.stdout.on('data', data => str += data);
        cp.on('error', () => deferred.resolve(false));
        cp.on('close', code => {
            if (code !== 0)
                return deferred.resolve(false);
            const parts = str.split(' ');
            if (parts.length < 3)
                return deferred.resolve(false);
            if (parts[1].startsWith(chromedriver_version)) {
                console.log(`ChromeDriver is already available at '${chromedriverBinaryFilePath}'.`);
                return deferred.resolve(true);
            }
            deferred.resolve(false);
        });
    }
    catch (error) {
        deferred.resolve(false);
    }
    return deferred.promise;
}

exports.findSuitableTempDirectory = function (chromedriver_version) {
    const now = Date.now();
    const candidateTmpDirs = [
        process.env.npm_config_tmp,
        process.env.XDG_CACHE_HOME,
        // Platform specific default, including TMPDIR/TMP/TEMP env
        os.tmpdir(),
        path.join(process.cwd(), 'tmp')
    ];

    for (let i = 0; i < candidateTmpDirs.length; i++) {
        if (!candidateTmpDirs[i]) continue;
        // Prevent collision with other versions in the dependency tree
        const namespace = chromedriver_version;
        const candidatePath = path.join(candidateTmpDirs[i], namespace, 'chromedriver');
        try {
            mkdirp.sync(candidatePath, '0777');
            const testFile = path.join(candidatePath, now + '.tmp');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            return candidatePath;
        } catch (e) {
            console.log(candidatePath, 'is not writable:', e.message);
        }
    }
    console.error('Can not find a writable tmp directory, please report issue on https://github.com/giggio/chromedriver/issues/ with as much information as possible.');
    process.exit(1);
}

exports.getRequestOptions = function (downloadPath) {
    /** @type import('axios').AxiosRequestConfig */
    const options = { url: downloadPath, method: "GET" };
    const urlParts = url.parse(downloadPath);
    const isHttps = urlParts.protocol === 'https:';
    const proxyUrl = isHttps
        ? process.env.npm_config_https_proxy
        : (process.env.npm_config_proxy || process.env.npm_config_http_proxy);
    if (proxyUrl) {
        const proxyUrlParts = url.parse(proxyUrl);
        options.proxy = {
            host: proxyUrlParts.hostname,
            port: proxyUrlParts.port ? parseInt(proxyUrlParts.port) : 80,
            protocol: proxyUrlParts.protocol
        };
    }

    if (isHttps) {
        // Use certificate authority settings from npm
        let ca = process.env.npm_config_ca;
        if (ca)
            console.log('Using npmconf ca.');

        if (!ca && process.env.npm_config_cafile) {
            try {
                ca = fs.readFileSync(process.env.npm_config_cafile, { encoding: 'utf8' });
            } catch (e) {
                console.error('Could not read cafile', process.env.npm_config_cafile, e);
            }
            console.log('Using npmconf cafile.');
        }

        if (proxyUrl) {
            console.log('Using workaround for https-url combined with a proxy.');
            const httpsProxyAgentOptions = url.parse(proxyUrl);
            // @ts-ignore
            httpsProxyAgentOptions.ca = ca;
            // @ts-ignore
            httpsProxyAgentOptions.rejectUnauthorized = !!process.env.npm_config_strict_ssl;
            // @ts-ignore
            options.httpsAgent = new HttpsProxyAgent(httpsProxyAgentOptions);
            options.proxy = false;
        } else {
            options.httpsAgent = new https.Agent({
                rejectUnauthorized: !!process.env.npm_config_strict_ssl,
                ca: ca
            });
        }
    }

    // Use specific User-Agent
    if (process.env.npm_config_user_agent) {
        options.headers = { 'User-Agent': process.env.npm_config_user_agent };
    }

    return options;
}

/**
 *
 * @param {import('axios').AxiosRequestConfig} requestOptions
 */
exports.getChromeDriverVersion = async function (requestOptions) {
    console.log('Finding Chromedriver version.');
    const response = await axios(requestOptions);
    return response.data.trim();
}

exports.getChromeDriverVersionFromUrl = async function (downloadPath) {
    let requestOptions = exports.getRequestOptions(downloadPath)
    return await exports.getChromeDriverVersion(requestOptions)
}

/**
 *
 * @param {import('axios').AxiosRequestConfig} requestOptions
 * @param {string} filePath
 */
exports.requestBinary = async function (requestOptions, filePath) {
    const outFile = fs.createWriteStream(filePath);
    let response;
    try {
        response = await axios.create(requestOptions)({ responseType: 'stream' });
    } catch (error) {
        if (error && error.response) {
            if (error.response.status)
                console.error('Error status code:', error.response.status);
            if (error.response.data) {
                error.response.data.on('data', data => console.error(data.toString('utf8')));
                await new Promise((resolve) => {
                    error.response.data.on('finish', resolve);
                    error.response.data.on('error', resolve);
                });
            }
        }
        throw new Error('Error with http(s) request: ' + error);
    }
    let count = 0;
    let notifiedCount = 0;
    response.data.on('data', data => {
        count += data.length;
        if ((count - notifiedCount) > 1024 * 1024) {
            console.log('Received ' + Math.floor(count / 1024) + 'K...');
            notifiedCount = count;
        }
    });
    response.data.on('end', () => console.log('Received ' + Math.floor(count / 1024) + 'K total.'));
    const pipe = response.data.pipe(outFile);
    await new Promise((resolve, reject) => {
        pipe.on('finish', resolve);
        pipe.on('error', reject);
    });
}

exports.extractDownload = async function (dirToExtractTo) {
    if (path.extname(downloadedFile) !== '.zip') {
        fs.copyFileSync(downloadedFile, chromedriverBinaryFilePath);
        console.log('Skipping zip extraction - binary file found.');
        return;
    }
    console.log(`Extracting zip contents to ${dirToExtractTo}.`);
    try {
        await extractZip(path.resolve(downloadedFile), { dir: dirToExtractTo });
    } catch (error) {
        throw new Error('Error extracting archive: ' + error);
    }
}

exports.copyIntoPlace = async function (originPath, targetPath) {
    await del(targetPath, { force: true });
    console.log("Copying to target path", targetPath);
    fs.mkdirSync(targetPath);

    // Look for the extracted directory, so we can rename it.
    const files = fs.readdirSync(originPath);
    const promises = files.map(name => {
        return new Promise((resolve) => {
            const file = path.join(originPath, name);
            const reader = fs.createReadStream(file);
            const targetFile = path.join(targetPath, name);
            const writer = fs.createWriteStream(targetFile);
            writer.on("close", () => resolve());
            reader.pipe(writer);
        });
    });
    await Promise.all(promises);
}

exports.fixFilePermissions = function () {
    // Check that the binary is user-executable and fix it if it isn't (problems with unzip library)
    if (process.platform != 'win32') {
        const stat = fs.statSync(helper.path);
        // 64 == 0100 (no octal literal in strict mode)
        if (!(stat.mode & 64)) {
            console.log('Fixing file permissions.');
            fs.chmodSync(helper.path, '755');
        }
    }
}

function Deferred() {
    this.resolve = null;
    this.reject = null;
    this.promise = new Promise(function (resolve, reject) {
        this.resolve = resolve;
        this.reject = reject;
    }.bind(this));
    Object.freeze(this);
}
