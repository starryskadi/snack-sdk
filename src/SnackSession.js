/**
 * @flow
 *
 * This tag is needed to prevent PubNub from showing up in docs
 * @private
 */

import PubNub from 'pubnub';
import shortid from 'shortid';
import debounce from 'lodash/debounce';
import pull from 'lodash/pull';
import isEqual from 'lodash/isEqual';
import pickBy from 'lodash/pickBy';
import cloneDeep from 'lodash/cloneDeep';
import difference from 'lodash/difference';
import { parse, print } from 'recast';
import * as babylon from 'babylon';
import semver from 'semver';

import constructExperienceURL from './utils/constructExperienceURL';
import sendFileUtils from './utils/sendFileUtils';
import { defaultSDKVersion, sdkSupportsFeature } from './configs/sdkVersions';
import npmVersionPins from './configs/npmVersions';

let platform = null;

// eslint-disable-next-line no-duplicate-imports
import type { SDKVersion, Feature } from './configs/sdkVersions';
import type {
  ExpoSnackFiles,
  ExpoSnackSessionArguments,
  ExpoSubscription,
  ExpoErrorListener,
  ExpoLogListener,
  ExpoPresenceStatus,
  ExpoPresenceListener,
  ExpoPubnubError,
  ExpoError,
  ExpoPubnubDeviceLog,
  ExpoDeviceLog,
  ExpoDevice,
  ExpoStateListener,
  ExpoDependencyErrorListener,
} from './types';

import insertImport from './utils/insertImport';
import moduleUtils from './utils/findAndWriteDependencyVersions';
import config from './configs/babylon';

type InitialState = {
  files: ExpoSnackFiles,
  name: ?string,
  description: ?string,
  dependencies: { [key: string]: string },
  sdkVersion?: SDKVersion,
};

type Module = {
  name: string,
  version?: ?string,
};

const parser = {
  parse: (code: string) => babylon.parse(code, config),
};

const MIN_CHANNEL_LENGTH = 6;
const DEBOUNCE_INTERVAL = 500;
const MAX_PUBNUB_SIZE = 31500;
const S3_BUCKET_URL = 'https://snack-code-uploads';

/**
 * Creates a snack session on the web. Multiple mobile devices can connect to the same session and each one will be updated when new code is pushed.
 * @param {object} options
 * @param {ExpoSnackFiles} options.files The initial React Native code.
 * @param {string} [options.name] Name shown if this Snack is saved.
 * @param {string} [options.description] Descriptions shown if this Snack is saved.
 * @param {string} [options.sessionId] Can be specified if you want a consistent url. This is a global namespace so make sure to use a UUID or scope it somehow if you use this.
 * @param {string} [options.sdkVersion] Determines what version of React Native is used on the mobile client. Defaults to 15.0.0 which maps to React Native 0.42.0. If you specify a different version, make sure to save that version along with the code. Code from one SDK version is not guaranteed to work on others.
 * @param {boolean} [options.verbose] Enable verbose logging mode.
 */
// host and snackId are not included in the docs since they are only used internally.
export default class SnackSession {
  files: ExpoSnackFiles;
  s3code: { [key: string]: string };
  diff: { [key: string]: string };
  s3url: { [key: string]: string };
  snackId: ?string;
  sdkVersion: SDKVersion;
  isVerbose: boolean;
  isStarted: boolean;
  pubnub: any;
  channel: string;
  errorListeners: Array<ExpoErrorListener> = [];
  logListeners: Array<ExpoLogListener> = [];
  presenceListeners: Array<ExpoPresenceListener> = [];
  stateListeners: Array<ExpoStateListener> = [];
  dependencyErrorListener: ExpoDependencyErrorListener;
  host: string;
  name: ?string;
  description: ?string;
  dependencies: any; // TODO: more specific
  initialState: InitialState;
  isResolving: boolean;
  expoApiUrl: string;
  snackagerUrl: string;
  snackagerCloudfrontUrl: string;
  authorizationToken: ?string;
  loadingMessage: ?string;

  // Public API
  constructor(options: ExpoSnackSessionArguments) {
    // TODO: check to make sure code was passed in

    this.isResolving = false;

    this.files = options.files;
    this.diff = {};
    this.s3url = {};
    this.s3code = {};
    this.sdkVersion = options.sdkVersion || defaultSDKVersion;
    this.isVerbose = !!options.verbose;
    this.channel = options.sessionId || shortid.generate();
    this.host = options.host || 'snack.expo.io';
    this.expoApiUrl = 'https://expo.io';
    this.snackagerUrl = 'https://snackager.expo.io';
    this.snackagerCloudfrontUrl = 'https://d37p21p3n8r8ug.cloudfront.net';
    this.authorizationToken = options.authorizationToken;
    this.snackId = options.snackId;
    this.name = options.name;
    this.description = options.description;
    this.dependencies = options.dependencies || {};
    this.initialState = cloneDeep({
      files: options.files,
      name: this.name,
      description: this.description,
      dependencies: this.dependencies,
      sdkVersion: this.sdkVersion,
    });

    if (this.channel.length < MIN_CHANNEL_LENGTH) {
      throw new Error('Please use a channel id with more entropy');
    }

    if (this.supportsFeature('ARBITRARY_IMPORTS')) {
      // TODO: do we actually need this here?
      this._handleFindDependenciesAsync();
    }

    this.pubnub = new PubNub({
      publishKey: 'pub-c-2a7fd67b-333d-40db-ad2d-3255f8835f70',
      subscribeKey: 'sub-c-0b655000-d784-11e6-b950-02ee2ddab7fe',
      ssl: true,
    });

    this.pubnub.addListener({
      message: ({ message }) => {
        switch (message.type) {
          case 'CONSOLE':
            this._handleLogMessage(message);
            break;
          case 'ERROR':
            this._handleErrorMessage(message);
            break;
          case 'RESEND_CODE':
            this._handleResendCodeMessage();
        }
      },
      presence: ({ action, uuid }) => {
        let device;

        try {
          device = JSON.parse(uuid);
        } catch (e) {
          // Wasn't from the device
          return;
        }

        switch (action) {
          case 'join':
            this._handleJoinMessage(device);
            break;
          case 'timeout':
          case 'leave':
            this._handleLeaveMessage(device);
            break;
        }
      },
      status: ({ category }) => {
        switch (category) {
          case 'PNConnectedCategory':
            break;
          case 'PNNetworkDownCategory':
          case 'PNNetworkIssuesCategory':
            this._log('Lost network connection.');
            break;
          case 'PNReconnectedCategory':
            this._log('Reconnected to PubNub server.');
            break;
          case 'PNNetworkUpCategory':
            this._log('Detected network connection. Subscribing to channel.');
            this._subscribe();
            break;
        }
      },
    });
  }

  /**
   * Starts the session.
   * @returns {Promise.<void>} A promise that resolves when the session is started.
   * @function
   */
  startAsync = async (): Promise<void> => {
    this.isStarted = true;
    this._subscribe();
  };

  /**
   * Stops the session.
   * @returns {Promise.<void>} A promise that resolves when the session is stopped.
   * @function
   */
  stopAsync = async (): Promise<void> => {
    this.s3url = {};
    this._unsubscribe();
  };

  /**
   * Returns a url that will open the current Snack session in the Expo client when opened on a phone. You can create a QR code from this link or send it to the phone in another way. See https://github.com/expo/snack-sdk/tree/master/example for how to turn this into a QR code.
   * @returns {Promise.<void>} A promise that contains the url when fulfilled.
   * @function
   */
  getUrlAsync = async (): Promise<string> => {
    const url = constructExperienceURL({
      sdkVersion: this.sdkVersion,
      snackId: this.snackId,
      channel: this.channel,
      host: this.host,
    });

    return url;
  };

  /**
   * Upload an asset file that will be available in each connected mobile client
   *
   * @param {Promise.<https://developer.mozilla.org/en-US/docs/Web/API/File>}
   * @returns {Promise.<string>} A promise that contains the url when fulfilled
   * @function
  */
  uploadAssetAsync = async (content: Object): Promise<string> => {
    return sendFileUtils.uploadAssetToS3(content, this.expoApiUrl);
  };

  /**
   * Push new code to each connected mobile client. Any clients that connect in the future will also get the new code.
   * @param {ExpoSnackFiles} files The new React Native code.
   * @returns {Promise.<void>} A promise that resolves when the code has been sent. Does not wait for the mobile clients to update before resolving.
   * @function
   */

  // TODO: parallelize
  sendCodeAsync = async (files: ExpoSnackFiles): Promise<void> => {
    // remove files that are no longer present in the code
    for (const key in this.files) {
      if (!files.hasOwnProperty(key)) {
        delete this.files[key];
      }
    }
    // and add or update the files in the provided code
    for (const key in files) {
      if (!this.files[key] || this.files[key] !== files[key]) {
        this.files[key] = files[key];
        if (this.files[key].type === 'ASSET' && typeof this.files[key].contents === 'object') {
          this.files[key].contents = await sendFileUtils.uploadAssetToS3(
            this.files[key].contents,
            this.expoApiUrl
          );
        }
      }
    }
    this._publish();
    this._sendStateEvent();
  };

  downloadAsync = async () => {
    const url = `${this.expoApiUrl}/--/api/v2/snack/download`;
    const save = await this.saveAsync();
    const id = save.id;
    return { url: url + '/' + id };
  };

  // TODO: error when changing SDK to an unsupported version
  setSdkVersion = (sdkVersion: SDKVersion): void => {
    if (this.sdkVersion !== sdkVersion) {
      this.sdkVersion = sdkVersion;

      this._sendStateEvent();
      this._handleFindDependenciesAsync();
    }
  };

  setName = (name: string): void => {
    if (this.name !== name) {
      this.name = name;

      this._sendStateEvent();
    }
  };

  setDescription = (description: string): void => {
    if (this.description !== description) {
      this.description = description;

      this._sendStateEvent();
    }
  };

  setAuthorizationToken = (token: ?string): void => {
    this.authorizationToken = token;
  };

  /**
   * Add a listener to get notified of error events.
   * @param {function(array)} callback - The callback that handles new error events. If there are no errors this will be called with an empty array. Otherwise will be called with an array of objects that each contain a `message` field.
   * @returns {object} A subscription object. Call `.remove()` on this object so stop getting new events.
   * @function
   */
  addErrorListener = (listener: ExpoErrorListener): ExpoSubscription => {
    this.errorListeners.push(listener);
    return {
      remove: () => {
        pull(this.errorListeners, listener);
      },
    };
  };

  /**
   * Add a listener to get notified of log events.
   * @param {function(object)} callback - The callback that handles new log events. Will be called with an object containing a `message` field.
   * @returns {object} A subscription object. Call `.remove()` on this object so stop getting new events.
   * @function
   */
  addLogListener = (listener: ExpoLogListener): ExpoSubscription => {
    this.logListeners.push(listener);
    return {
      remove: () => {
        pull(this.logListeners, listener);
      },
    };
  };

  /**
   * Add a listener to get notified of presence events.
   * @param {function(object)} callback - The callback that handles new presence events. Will be called with an object containing a `status` field.
   * @returns {object} A subscription object. Call `.remove()` on this object so stop getting new events.
   * @function
   */
  addPresenceListener = (listener: ExpoPresenceListener): ExpoSubscription => {
    this.presenceListeners.push(listener);
    return {
      remove: () => {
        pull(this.presenceListeners, listener);
      },
    };
  };

  addStateListener = (listener: ExpoStateListener): ExpoSubscription => {
    this.stateListeners.push(listener);
    return {
      remove: () => {
        pull(this.stateListeners, listener);
      },
    };
  };

  /**
   * Uploads the current code to Expo's servers and return a url that points to that version of the code.
   * @returns {Promise.<object>} A promise that contains an object with a `url` field when fulfilled.
   * @function
   */

  saveAsync = async () => {
    const url = `${this.expoApiUrl}/--/api/v2/snack/save`;
    const manifest: {
      sdkVersion: string,
      name: ?string,
      description: ?string,
      dependencies?: Object,
    } = {
      sdkVersion: this.sdkVersion,
      name: this.name,
      description: this.description,
    };

    if (this.supportsFeature('ARBITRARY_IMPORTS')) {
      manifest.dependencies = this.dependencies;
    }

    const payload = {
      manifest,
      code: this.files,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json',
          ...(this.authorizationToken
            ? { Authorization: `Bearer ${this.authorizationToken}` }
            : {}),
        },
      });
      const data = await response.json();

      if (data.id) {
        this.initialState = cloneDeep({
          sdkVersion: this.sdkVersion,
          files: this.files,
          name: this.name,
          description: this.description,
          dependencies: this.dependencies,
        });
        this._sendStateEvent();
        let fullName;
        if (data.id.match(/.*\/.*/)) {
          fullName = data.id;
        } else {
          fullName = `@snack/${data.id}`;
        }

        return {
          id: data.id,
          url: `https://expo.io/${fullName}`,
        };
      } else {
        throw new Error(
          (data.errors && data.errors[0] && data.errors[0].message) || 'Failed to save code'
        );
      }
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  getState = () => {
    return {
      files: this.files,
      sdkVersion: this.sdkVersion,
      name: this.name,
      description: this.description,
      dependencies: this.dependencies,
      isSaved: this._isSaved(),
      isResolving: this.isResolving,
    };
  };

  getChannel = () => {
    return this.channel;
  };

  supportsFeature = (feature: Feature) => {
    return sdkSupportsFeature(this.sdkVersion, feature);
  };

  // Private methods

  _sendErrorEvent = (errors: Array<ExpoError>): void => {
    this.errorListeners.forEach(listener => listener(errors));
  };

  _sendLogEvent = (log: ExpoDeviceLog): void => {
    this.logListeners.forEach(listener => listener(log));
  };

  _sendPresenceEvent = (device: ExpoDevice, status: ExpoPresenceStatus): void => {
    this.presenceListeners.forEach(listener =>
      listener({
        device,
        status,
      })
    );
  };

  _isSaved = (): boolean => {
    const { files, name, description, dependencies, sdkVersion, initialState } = this;

    return isEqual(initialState, {
      files,
      name,
      description,
      dependencies,
      sdkVersion,
    });
  };

  _sendStateEvent = (): void => {
    this.stateListeners.forEach(listener => listener(this.getState()));
  };

  _subscribe = () => {
    this.pubnub.subscribe({
      channels: [this.channel],
      withPresence: true,
    });
  };

  _unsubscribe = () => {
    this.pubnub.unsubscribe({
      channels: [this.channel],
    });
  };

  //s3code: cache of code saved on s3
  //s3url: url to code stored on s3
  //diff: code diff sent to phone
  _handleUploadCodeAsync = async () => {
    const fileSize = [];
    await this._uploadHelper(fileSize);

    let size = sendFileUtils.calcPayloadSize(this.channel, {
      diff: this.diff,
      s3url: this.s3url,
    });

    //TODO: make this async
    // If payload size is too big, upload code to s3 (starting from largest file)
    if (size > MAX_PUBNUB_SIZE) {
      fileSize.sort((a, b) => a.size - b.size);
      while (size > MAX_PUBNUB_SIZE && fileSize.length) {
        const key = fileSize.pop().name;
        this.s3code[key] = this.files[key].contents;
        this.diff[key] = '';
        this.s3url[key] = await sendFileUtils.uploadCodeToS3(
          this.files[key].contents,
          this.expoApiUrl
        );
        size = sendFileUtils.calcPayloadSize(this.channel, {
          diff: this.diff,
          s3url: this.s3url,
        });
      }
    }
  };

  // Turn files into diff, s3url, and s3code
  _uploadHelper = async (fileSize: Array<Object>) => {
    await Promise.all(
      Object.keys(this.files).map(async key => {
        if (!this.files[key]) {
          return;
        } else if (typeof this.files[key].contents === 'object') {
          // Upload Asset to S3
          this.s3code[key] = this.files[key].contents;
          this.diff[key] = '';
          this.s3url[key] = await sendFileUtils.uploadAssetToS3(
            this.files[key].contents,
            this.expoApiUrl
          );
        } else if (this.files[key].contents.startsWith(S3_BUCKET_URL)) {
          // Asset is already uploaded
          this.diff[key] = '';
          this.s3code[key] = this.files[key].contents;
          this.s3url[key] = this.files[key].contents;
        } else if (this.s3url[key]) {
          // Send diff against code on s3
          this.diff[key] = sendFileUtils.getFileDiff(this.s3code[key], this.files[key].contents);
        } else {
          // Send all of the code in diff (file small enough not to be uploaded)
          this.diff[key] = sendFileUtils.getFileDiff('', this.files[key].contents);
        }
        fileSize.push({ name: key, size: this.diff[key].length });
      })
    );
  };

  _handleLogMessage = (pubnubEvent: ExpoPubnubDeviceLog) => {
    let payload = pubnubEvent.payload || [];

    let message = {
      device: pubnubEvent.device,
      method: pubnubEvent.method,
      message: payload.join(' '),
      arguments: payload,
    };
    this._sendLogEvent(message);
  };

  _handleErrorMessage = ({ error, device }: { error: string, device?: ExpoDevice }) => {
    if (error) {
      let rawErrorObject: ExpoPubnubError = JSON.parse(error);
      let errorObject: ExpoError = {
        message: rawErrorObject.message || '',
        device,
        stack: rawErrorObject.stack,
      };

      if (rawErrorObject.line) {
        errorObject.startLine = errorObject.endLine = rawErrorObject.line;
      }

      if (rawErrorObject.column) {
        errorObject.startColumn = errorObject.endColumn = rawErrorObject.column;
      }

      if (rawErrorObject.loc) {
        errorObject.startLine = errorObject.endLine = rawErrorObject.loc.line;
        errorObject.startColumn = errorObject.endColumn = rawErrorObject.loc.column;
      }

      this._sendErrorEvent([errorObject]);
    } else {
      this._sendErrorEvent([]);
    }
  };

  _handleResendCodeMessage = () => {
    this._publishNotDebouncedAsync();
  };

  _handleJoinMessage = (device: ExpoDevice) => {
    this._publishNotDebouncedAsync();
    this._sendPresenceEvent(device, 'join');
  };

  _handleLeaveMessage = (device: ExpoDevice) => {
    this._sendPresenceEvent(device, 'leave');
  };

  _publishNotDebouncedAsync = async () => {
    if (this.loadingMessage) {
      this._sendLoadingEvent();
    } else {
      if (this.supportsFeature('ARBITRARY_IMPORTS')) {
        await this._handleFindDependenciesAsync();
      }

      if (this.isResolving) {
        // shouldn't ever happen
        return;
      }

      const metadata = this._getAnalyticsMetadata();
      let message;
      if (this.supportsFeature('MULTIPLE_FILES')) {
        await this._handleUploadCodeAsync();
        message = {
          type: 'CODE',
          diff: this.diff,
          s3url: this.s3url,
          metadata,
        };
      } else {
        message = {
          type: 'CODE',
          code: this.files['app.js'].contents,
          metadata,
        };
      }

      this.pubnub.publish({ channel: this.channel, message }, (status, response) => {
        if (status.error) {
          this._error(`Error publishing code: ${status.error}`);
        } else {
          this._log('Published successfully!');
        }
      });
    }
  };

  _sendLoadingEvent = () => {
    if (!this.loadingMessage) {
      return;
    }

    const payload = { type: 'LOADING_MESSAGE', message: this.loadingMessage };
    if (!this.pubnub) {
      return;
    }
    this.pubnub.publish({ channel: this.channel, message: payload }, (status, response) => {
      if (status.error) {
        this._error(`Error publishing loading event: ${status.error}`);
      } else {
        this._log(`Sent loading event with message: ${this.loadingMessage || ''}`);
      }
    });
  };

  _getAnalyticsMetadata = () => {
    let metadata = {
      expoSdkVersion: this.sdkVersion,
    };

    try {
      metadata = {
        ...metadata,
        webSnackSdkVersion: require('../package.json').version,
      };
    } catch (e) {
      // Probably couldn't require version
    }

    if (typeof window !== 'undefined') {
      metadata = {
        ...metadata,
        webHostname: window.location.hostname,
      };
    }

    if (typeof navigator !== 'undefined') {
      if (!platform) {
        try {
          platform = require('platform');
        } catch (e) {
          // platform has side effects. should be fine but try/catch just to be safe.
        }
      }

      if (platform) {
        const platformInfo = platform.parse(navigator.userAgent);
        const os = platformInfo.os || {};
        metadata = {
          ...metadata,
          webOSArchitecture: os.architecture,
          webOSFamily: os.family,
          webOSVersion: os.version,
          webLayoutEngine: platformInfo.layout,
          webDeviceType: platformInfo.product,
          webBrowser: platformInfo.name,
          webBrowserVersion: platformInfo.version,
          webDescription: platformInfo.description,
        };
      }
    }

    return metadata;
  };

  _publish = debounce(this._publishNotDebouncedAsync, DEBOUNCE_INTERVAL);

  _error = (message: string) => {
    if (this.isVerbose) {
      console.error(message);
    }
  };

  _log = (message: string) => {
    if (this.isVerbose) {
      console.log(message);
    }
  };

  // ARBITRARY NPM MODULES

  _tryFetchDependencyAsync = async (name: string, version: ?string) => {
    let count = 0;
    let data;

    while (data ? data.pending : true) {
      if (count > 30) {
        throw new Error('Request timed out');
      }

      count++;

      this._log(
        `Requesting dependency: ${this.snackagerUrl}/bundle/${name}${version
          ? `@${version}`
          : ''}?platforms=ios,android`
      );
      const res = await fetch(
        `${this.snackagerUrl}/bundle/${name}${version ? `@${version}` : ''}?platforms=ios,android`
      );

      if (res.status === 200) {
        data = await res.json();

        if (data.pending) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      } else {
        const error = await res.text();
        throw new Error(error);
      }
    }

    return data;
  };

  _promises = {};
  _maybeFetchDependencyAsync = async (name: string, version: ?string) => {
    const id = `${name}-${version || 'latest'}`;

    // Cache the promise to avoid sending same request more than once
    this._promises[id] =
      this._promises[id] ||
      this._tryFetchDependencyAsync(name, version)
        .then(data => {
          this._promises[id] = data;
          return data;
        })
        .catch(async e => {
          this._error(`Error fetching dependency: ${e}`);

          if (await this._checkS3ForDepencencyAsync(name, version || 'latest')) {
            // Snackager returned an error but the dependency is uploaded
            // to s3.
            this._promises[id] = {
              name,
              version: version || npmVersionPins.default,
              error: e.toString(),
            };
          } else {
            // Snackager returned an error and can't find on S3.
            this._promises[id] = {
              name,
              version: npmVersionPins.error,
            };

            if (this.dependencyErrorListener) {
              this.dependencyErrorListener(`Error fetching ${name}@${version || 'latest'}: ${e}`);
            }
          }
          return this._promises[id];
        });
    return this._promises[id];
  };

  _checkS3ForDepencencyAsync = async (name: string, version: string) => {
    const hash = (name + '@' + version).replace(/\//g, '~');
    const promises = ['ios', 'android'].map(async platform => {
      try {
        let url = `${this.snackagerCloudfrontUrl}/${encodeURIComponent(hash)}-${platform}/.done`;

        const res = await fetch(url);
        return res.status < 400;
      } catch (e) {
        return false;
      }
    });

    let results = await Promise.all(promises);
    return results.every(result => result);
  };

  _handleFindDependenciesAsync = async () => {
    if (!this.supportsFeature('ARBITRARY_IMPORTS')) {
      return;
    }

    const files = this.files;

    if (this.isResolving) {
      return;
    }

    this.isResolving = true;

    try {
      await Promise.all(
        Object.keys(files).map(async key => {
          if (key.endsWith('.js')) {
            const codeAtStartOfFindDependencies = files[key].contents;
            const codeWithVersions = await this._findDependenciesOnceAsync(files[key].contents);
            if (files[key].contents === codeAtStartOfFindDependencies) {
              // can be null if no changes need to be made
              if (codeWithVersions) {
                files[key].contents = codeWithVersions;
                this._sendStateEvent();
              }
            }
          }
        })
      );
    } catch (e) {
      console.error(e);
    } finally {
      this.loadingMessage = null;
      this.isResolving = false;
      this._sendStateEvent();
    }
  };

  _findDependenciesOnceAsync = async (file: string): Promise<?string> => {
    if (!this.supportsFeature('ARBITRARY_IMPORTS')) {
      return null;
    }

    const reserved = ['react', 'react-native', 'expo'];

    let modules: { [string]: string };
    try {
      // Find all module imports in the code
      // This will skip local imports and reserved ones
      modules = pickBy(
        moduleUtils.findModuleDependencies(file),
        (version: string, module: string) => !module.startsWith('.') && !reserved.includes(module)
      );
    } catch (e) {
      // Likely a parse error
      this._error(`Couldn't find dependencies: ${e}`);
      return null;
    }

    // Check if the dependencies already exist
    const changedModules = Object.keys(modules).filter(moduleName => {
      return (
        !this.dependencies.hasOwnProperty(moduleName) ||
        modules[moduleName] !== this.dependencies[moduleName]
      );
    });
    if (!Object.keys(modules).length || !changedModules.length) {
      this._log(`All dependencies are already loaded: ${JSON.stringify(modules)}`);
      return null;
    }

    this._sendStateEvent();
    this.loadingMessage = `Installing dependencies`;
    this._sendLoadingEvent();

    try {
      // Fetch the dependencies
      // This will also trigger bundling
      this._log(`Fetching dependencies: ${JSON.stringify(modules)}`);
      const results = await Promise.all(
        Object.keys(modules).map(name => this._maybeFetchDependencyAsync(name, modules[name]))
      );
      this._log(`Got dependencies: ${JSON.stringify(results)}`);
      // results will have an error key if they failed

      let peerDependencies = {};

      // Some items might have peer dependencies
      // We need to collect them and install them
      results.map(it => {
        if (it.dependencies) {
          Object.keys(it.dependencies).forEach(name => {
            if (!reserved.includes(name)) {
              peerDependencies[name] = it.dependencies[name];
            }
          });
        }
      });

      // Set dependencies to the updated list
      this.dependencies = { ...this.dependencies, ...peerDependencies };
      this._sendStateEvent();

      // Fetch the peer dependencies
      this._log(`Fetching peer dependencies: ${JSON.stringify(peerDependencies)}`);
      peerDependencies = await Promise.all(
        Object.keys(peerDependencies).map(name =>
          /* $FlowFixMe */
          this._maybeFetchDependencyAsync(name, peerDependencies[name])
        )
      );

      // Collect all dependency and peer dependency names and version
      const dependencies = {};

      // do peerDeps first to make sure we prioritize the non-peerDeps versions
      peerDependencies.forEach(it => {
        dependencies[it.name] = it.version;
      });

      results.forEach(it => {
        dependencies[it.name] = it.version;
      });

      let code = file;

      // We need to insert peer dependencies in code when found
      if (peerDependencies.length) {
        const ast = parse(code, { parser });

        this._log(`Adding imports for peer dependencies: ${JSON.stringify(peerDependencies)}`);
        peerDependencies.forEach(it =>
          insertImport(ast, {
            // Insert an import statement for the module
            // This will skip the import if already present
            from: it.name,
          })
        );

        code = print(ast).code;
      }

      this._log('Writing module versions');
      code = moduleUtils.writeModuleVersions(code, dependencies);

      // TODO: this system will not remove old dependencies that are no longer needed!
      Object.assign(this.dependencies, dependencies);
      this._sendStateEvent();

      return code;
    } catch (e) {
      // TODO: Show user that there is an error getting dependencies
      this._error(`Error in _findDependenciesOnceAsync: ${e}`);
    } finally {
      this._sendStateEvent();
    }
  };
}
