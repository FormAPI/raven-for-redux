"use strict";

var stringify = require("./vendor/json-stringify-safe/stringify");

var identity = function identity(x) {
  return x;
};
var getUndefined = function getUndefined() {};
var filter = function filter() {
  return true;
};
function createRavenMiddleware(Raven) {
  var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

  // TODO: Validate options.
  var _options$breadcrumbDa = options.breadcrumbDataFromAction,
      breadcrumbDataFromAction = _options$breadcrumbDa === undefined ? getUndefined : _options$breadcrumbDa,
      _options$actionTransf = options.actionTransformer,
      actionTransformer = _options$actionTransf === undefined ? identity : _options$actionTransf,
      _options$stateTransfo = options.stateTransformer,
      stateTransformer = _options$stateTransfo === undefined ? identity : _options$stateTransfo,
      _options$breadcrumbCa = options.breadcrumbCategory,
      breadcrumbCategory = _options$breadcrumbCa === undefined ? "redux-action" : _options$breadcrumbCa,
      _options$filterBreadc = options.filterBreadcrumbActions,
      filterBreadcrumbActions = _options$filterBreadc === undefined ? filter : _options$filterBreadc,
      getUserContext = options.getUserContext,
      getTags = options.getTags;


  return function (store) {
    var lastAction = void 0;

    Raven.setDataCallback(function (data, original) {
      var state = store.getState();
      var reduxExtra = {
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

    var retryCaptureWithoutReduxState = function retryCaptureWithoutReduxState(errorMessage, captureFn) {
      Raven.setDataCallback(function (data, originalCallback) {
        Raven.setDataCallback(originalCallback);
        var reduxExtra = {
          lastAction: actionTransformer(lastAction),
          state: errorMessage
        };
        data.extra = Object.assign(reduxExtra, data.extra);
        data.breadcrumbs.values = [];
        return data;
      });
      // Raven has an internal check for duplicate errors that we need to disable.
      var originalAllowDuplicates = Raven._globalOptions.allowDuplicates;
      Raven._globalOptions.allowDuplicates = true;
      captureFn();
      Raven._globalOptions.allowDuplicates = originalAllowDuplicates;
    };

    var retryWithoutStateIfRequestTooLarge = function retryWithoutStateIfRequestTooLarge(originalFn) {
      return function () {
        for (var _len = arguments.length, captureArguments = Array(_len), _key = 0; _key < _len; _key++) {
          captureArguments[_key] = arguments[_key];
        }

        var originalTransport = Raven._globalOptions.transport;
        Raven.setTransport(function (opts) {
          Raven.setTransport(originalTransport);
          var requestBody = stringify(opts.data);
          if (requestBody.length > 200000) {
            // We know the request is too large, so don't try sending it to Sentry.
            // Retry the capture function, and don't include the state this time.
            var errorMessage = "Could not send state because request would be larger than 200KB. " + ("(Was: " + requestBody.length + "B)");
            retryCaptureWithoutReduxState(errorMessage, function () {
              originalFn.apply(Raven, captureArguments);
            });
            return;
          }
          opts.onError = function (error) {
            if (error.request && error.request.status === 413) {
              var _errorMessage = "Failed to submit state to Sentry: 413 request too large.";
              retryCaptureWithoutReduxState(_errorMessage, function () {
                originalFn.apply(Raven, captureArguments);
              });
            }
          };
          (originalTransport || Raven._makeRequest).call(Raven, opts);
        });
        originalFn.apply(Raven, captureArguments);
      };
    };

    Raven.captureException = retryWithoutStateIfRequestTooLarge(Raven.captureException);
    Raven.captureMessage = retryWithoutStateIfRequestTooLarge(Raven.captureMessage);

    return function (next) {
      return function (action) {
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
  };
}

module.exports = createRavenMiddleware;