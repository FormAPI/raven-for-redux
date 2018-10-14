const stringify = require("./vendor/json-stringify-safe/stringify");
const pako = require('pako');

// This is to be defensive in environments where window does not exist (see https://github.com/getsentry/raven-js/pull/785)
const _window =
  typeof window !== 'undefined'
    ? window
    : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

/**
 * hasKey, a better form of hasOwnProperty
 * Example: hasKey(MainHostObject, property) === true/false
 *
 * @param {Object} host object to check property
 * @param {string} key to check
 */
function hasKey(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isUndefined(what) {
  return what === void 0;
}

function each(obj, callback) {
  var i, j;

  if (isUndefined(obj.length)) {
    for (i in obj) {
      if (hasKey(obj, i)) {
        callback.call(null, i, obj[i]);
      }
    }
  } else {
    j = obj.length;
    if (j) {
      for (i = 0; i < j; i++) {
        callback.call(null, i, obj[i]);
      }
    }
  }
}

function supportsFetch() {
  if (!('fetch' in _window)) return false;

  try {
    new Headers(); // eslint-disable-line no-new
    new Request(''); // eslint-disable-line no-new
    new Response(); // eslint-disable-line no-new
    return true;
  } catch (e) {
    return false;
  }
}

function urlencode(o) {
  var pairs = [];
  each(o, function(key, value) {
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
  });
  return pairs.join('&');
}

function objectMerge(obj1, obj2) {
  if (!obj2) {
    return obj1;
  }
  each(obj2, function(key, value) {
    obj1[key] = value;
  });
  return obj1;
}


// Unfortunately, this doesn't work at the moment, because Sentry doesn't allow us to
// send a Content-Encoding header. The CORS preflight request returns:
//
//    Access-Control-Allow-Headers: X-Sentry-Auth, X-Requested-With,
//        Origin, Accept, Content-Type, Authentication
//
// (Content-Encoding is missing.)
//
// Also it might be dangerous for them to support gzip/deflate, because people could
// send gzip bombs (a tiny amount of compressed data that expands to gigabytes on disk)
// But maybe there's a decompression library that can be configured to abort after a max size.

const makeRequestWithZlib = function(opts, shouldSendRequest) {
  // Auth is intentionally sent as part of query string (NOT as custom HTTP header) to avoid preflight CORS requests
  var url = opts.url + '?' + urlencode(opts.auth);

  var evaluatedHeaders = null;
  var evaluatedFetchParameters = {};

  if (opts.options.headers) {
    evaluatedHeaders = this._evaluateHash(opts.options.headers);
  }

  if (opts.options.fetchParameters) {
    evaluatedFetchParameters = this._evaluateHash(opts.options.fetchParameters);
  }

  const requestJSON = stringify(opts.data);
  const requestDeflate = pako.deflate(requestJSON, { to: 'string' });

  if (shouldSendRequest && !shouldSendRequest(requestDeflate)) {
    return;
  }

  if (supportsFetch()) {
    var defaultFetchOptions = objectMerge({}, this._fetchDefaults);
    var fetchOptions = objectMerge(defaultFetchOptions, evaluatedFetchParameters);

    if (evaluatedHeaders) {
      fetchOptions.headers = evaluatedHeaders;
    }

    evaluatedFetchParameters.body = requestDeflate

    fetchOptions.headers = Object.assign(fetchOptions.headers || {}, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'deflate',
    })

    return _window
      .fetch(url, fetchOptions)
      .then(function(response) {
        if (response.ok) {
          opts.onSuccess && opts.onSuccess();
        } else {
          var error = new Error('Sentry error code: ' + response.status);
          // It's called request only to keep compatibility with XHR interface
          // and not add more redundant checks in setBackoffState method
          error.request = response;
          opts.onError && opts.onError(error);
        }
      })
      ['catch'](function() {
        opts.onError &&
          opts.onError(new Error('Sentry error code: network unavailable'));
      });
  }

  var request = _window.XMLHttpRequest && new _window.XMLHttpRequest();
  if (!request) return;

  // if browser doesn't support CORS (e.g. IE7), we are out of luck
  var hasCORS = 'withCredentials' in request || typeof XDomainRequest !== 'undefined';

  if (!hasCORS) return;

  if ('withCredentials' in request) {
    request.onreadystatechange = function() {
      if (request.readyState !== 4) {
        return;
      } else if (request.status === 200) {
        opts.onSuccess && opts.onSuccess();
      } else if (opts.onError) {
        var err = new Error('Sentry error code: ' + request.status);
        err.request = request;
        opts.onError(err);
      }
    };
  } else {
    request = new XDomainRequest();
    // xdomainrequest cannot go http -> https (or vice versa),
    // so always use protocol relative
    url = url.replace(/^https?:/, '');

    // onreadystatechange not supported by XDomainRequest
    if (opts.onSuccess) {
      request.onload = opts.onSuccess;
    }
    if (opts.onError) {
      request.onerror = function() {
        var err = new Error('Sentry error code: XDomainRequest');
        err.request = request;
        opts.onError(err);
      };
    }
  }

  request.open('POST', url);

  if (evaluatedHeaders) {
    each(evaluatedHeaders, function(key, value) {
      request.setRequestHeader(key, value);
    });
  }

  request.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
  request.setRequestHeader('Content-Encoding', 'deflate');

  request.send(requestDeflate);
}


const identity = x => x;
const getUndefined = () => {};
const filter = () => true;
function createRavenMiddleware(Raven, options = {}) {
  // TODO: Validate options.
  const {
    breadcrumbDataFromAction = getUndefined,
    actionTransformer = identity,
    stateTransformer = identity,
    breadcrumbCategory = "redux-action",
    filterBreadcrumbActions = filter,
    getUserContext,
    getTags
  } = options;

  return store => {
    let lastAction;

    Raven.setDataCallback((data, original) => {
      const state = store.getState();
      const reduxExtra = {
        lastAction: actionTransformer(lastAction),
        state: stateTransformer(state)
      };
      data.extra = Object.assign(reduxExtra, data.extra);
      if (getUserContext) {
        data.user = getUserContext(state);
      }
      if (getTags) {
        data.tags = getTags(state);
      }
      return original ? original(data) : data;
    });

    const retryCaptureWithoutReduxState = (errorMessage, captureFn) => {
      Raven.setDataCallback((data, originalCallback) => {
        Raven.setDataCallback(originalCallback);
        const reduxExtra = {
          lastAction: actionTransformer(lastAction),
          state: errorMessage
        };
        data.extra = Object.assign(reduxExtra, data.extra);
        data.breadcrumbs.values = [];
        return data;
      });
      // Raven has an internal check for duplicate errors that we need to disable.
      const originalAllowDuplicates = Raven._globalOptions.allowDuplicates;
      Raven._globalOptions.allowDuplicates = true;
      captureFn();
      Raven._globalOptions.allowDuplicates = originalAllowDuplicates;
    };

    const retryWithoutStateIfRequestTooLarge = originalFn => {
      return (...captureArguments) => {
        const originalTransport = Raven._globalOptions.transport;
        Raven.setTransport(opts => {
          Raven.setTransport(originalTransport);
          opts.onError = error => {
            if (error.request && error.request.status === 413) {
              const errorMessage =
                "Failed to submit state to Sentry: 413 request too large.";
              retryCaptureWithoutReduxState(errorMessage, () => {
                originalFn.apply(Raven, captureArguments);
              });
            }
          };

          makeRequestWithZlib(opts, (requestBody) => {
            if (requestBody.length > 200000) {
              // We know the request is too large, so don't try sending it to Sentry.
              // Retry the capture function, and don't include the state this time.
              const errorMessage =
                "Could not send state because request would be larger than 200KB. " +
                `(Was: ${requestBody.length}B)`;
              retryCaptureWithoutReduxState(errorMessage, () => {
                originalFn.apply(Raven, captureArguments);
              });
              return false;
            }
            return true;
          });
        });
        originalFn.apply(Raven, captureArguments);
      };
    };

    Raven.captureException = retryWithoutStateIfRequestTooLarge(
      Raven.captureException
    );
    Raven.captureMessage = retryWithoutStateIfRequestTooLarge(
      Raven.captureMessage
    );

    // Set the default transport to use zlib compression
    Raven.setTransport(makeRequestWithZlib.bind(Raven));

    return next => action => {
      // Log the action taken to Raven so that we have narrative context in our
      // error report.
      if (filterBreadcrumbActions(action)) {
        Raven.captureBreadcrumb({
          category: breadcrumbCategory,
          message: action.type,
          data: breadcrumbDataFromAction(action)
        });
      }

      lastAction = action;
      return next(action);
    };
  };
}

module.exports = createRavenMiddleware;
