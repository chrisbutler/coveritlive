//
//  coveritlive API Wrapper
//
var assert = require('assert');
var request = require('request');
var endpoints = require('./endpoints');


var coveritlive = function (token) {
  this.token = token;
}

coveritlive.prototype.setAuth = function (token) {
  var self = this;
  self.token = token;
}

coveritlive.prototype.getAuth = function () {
  return this.token
}

coveritlive.prototype.get = function (path, params, callback) {
  return this.request('GET', path, params, callback)
}

coveritlive.prototype.post = function (path, params, callback) {
  return this.request('POST', path, params, callback)
}

coveritlive.prototype.request = function (method, path, params, callback) {
  var self = this
  assert(method == 'GET' || method == 'POST')
  // if no `params` is specified but a callback is, use default params
  if (typeof params === 'function') {
    callback = params
    params = {}
  }

  self._buildReqOpts(method, path, params, false, function (err, reqOpts) {
    if (err) {
      callback(err, null, null)
      return
    }

    var cilOptions = (params && params.cil_options) || {}

    process.nextTick(function () {
      // ensure all HTTP i/o occurs after the user has a chance to bind their event handlers
      self._doRestApiRequest(reqOpts, cilOptions, method, callback)
    })
  })

  return self
}

/**
 * Builds and returns an options object ready to pass to `request()`
 * @param  {String}   method      "GET" or "POST"
 * @param  {String}   path        REST API resource uri (eg. "statuses/destroy/:id")
 * @param  {Object}   params      user's params object
 * @param  {Boolean}  isStreaming Flag indicating if it's a request to the Streaming API (different endpoint)
 * @returns {Undefined}
 *
 * Calls `callback` with Error, Object where Object is an options object ready to pass to `request()`.
 *
 * Returns error raised (if any) by `helpers.moveParamsIntoPath()`
 */
coveritlive.prototype._buildReqOpts = function (method, path, params, isStreaming, callback) {
  var self = this
  if (!params) {
    params = {}
  }
  // clone `params` object so we can modify it without modifying the user's reference
  var paramsClone = JSON.parse(JSON.stringify(params))
  // convert any arrays in `paramsClone` to comma-seperated strings
  var finalParams = this.normalizeParams(paramsClone)
  delete finalParams.cil_options

  // the options object passed to `request` used to perform the HTTP request
  var reqOpts = {
    headers: {

    },
    // gzip: true,
  }
  // TODO(tolga): test with gzip: true

  try {
    // finalize the `path` value by building it using user-supplied params
    path = helpers.moveParamsIntoPath(finalParams, path)
  } catch (e) {
    callback(e, null, null)
    return
  }

  if (isStreaming) {
    var stream_endpoint_map = {
      user: endpoints.USER_STREAM,
      site: endpoints.SITE_STREAM
    }
    var endpoint = stream_endpoint_map[path] || endpoints.PUB_STREAM
    reqOpts.url = endpoint + path + '.json'
  } else {
    // special case for media/upload
    if (path === 'media/upload') {
      reqOpts.url = endpoints.MEDIA_UPLOAD + 'media/upload.json'
      reqOpts.headers['Content-type'] = 'multipart/form-data'
      reqOpts.formData = finalParams
      // set finalParams to empty object so we don't append a query string
      // of the params
      finalParams = {}
    } else {
      reqOpts.url = endpoints.REST_ROOT + path + '.json'
      reqOpts.headers['Content-type'] = 'application/json'
    }
  }

  if (Object.keys(finalParams).length) {
    // not all of the user's parameters were used to build the request path
    // add them as a query string
    var qs = helpers.makeQueryString(finalParams)
    reqOpts.url += '?' + qs
  }

  if (!self.config.app_only_auth) {
    // with user auth, we can just pass an oauth object to requests
    // to have the request signed
    reqOpts.oauth = {
      consumer_key: self.config.consumer_key,
      consumer_secret: self.config.consumer_secret,
      token: self.config.access_token,
      token_secret: self.config.access_token_secret,
    }

    callback(null, reqOpts);
    return;
  } else {
    // we're using app-only auth, so we need to ensure we have a bearer token
    // Once we have a bearer token, add the Authorization header and return the fully qualified `reqOpts`.
    self._getBearerToken(function (err, bearerToken) {
      if (err) {
        callback(err, null)
        return
      }

      reqOpts.headers['Authorization'] = 'Bearer ' + bearerToken;
      callback(null, reqOpts)
      return
    })
  }
}

/**
 * Make HTTP request to coveritlive REST API.
 * @param  {Object}   reqOpts     options object passed to `request()`
 * @param  {Object}   cilOptions
 * @param  {String}   method      "GET" or "POST"
 * @param  {Function} callback    user's callback
 * @return {Undefined}
 */
coveritlive.prototype._doRestApiRequest = function (reqOpts, cilOptions, method, callback) {
  var request_method = request[method.toLowerCase()];
  var req = request_method(reqOpts);

  var body = '';
  var response = null;

  var onRequestComplete = function () {
    try {
      body = JSON.parse(body)
    } catch (jsonDecodeError) {
      // there was no transport-level error, but a JSON object could not be decoded from the request body
      // surface this to the caller
      var err = helpers.makeCilError('JSON decode error: coveritlive HTTP response body was not valid JSON')
      err.statusCode = response ? response.statusCode: null;
      err.allErrors.concat({error: jsonDecodeError.toString()})
      callback(err, body, response);
      return
    }

    if (body.error || body.errors) {
      // we got a coveritlive API-level error response
      // place the errors in the HTTP response body into the Error object and pass control to caller
      var err = helpers.makeCilError('coveritlive API Error')
      err.statusCode = response ? response.statusCode: null;
      helpers.attachBodyInfoToError(err, body);
      callback(err, body, response);
      return
    }

    // success case - no errors in HTTP response body
    callback(err, body, response)
  }

  req.on('response', function (res) {
    response = res
    // read data from `request` object which contains the decompressed HTTP response body,
    // `response` is the unmodified http.IncomingMessage object which may contain compressed data
    req.on('data', function (chunk) {
      body += chunk.toString('utf8')
    })
    // we're done reading the response
    req.on('end', function () {
      onRequestComplete()
    })
  })

  req.on('error', function (err) {
    // transport-level error occurred - likely a socket error
    if (cilOptions.retry &&
        STATUS_CODES_TO_ABORT_ON.indexOf(err.statusCode) !== -1
    ) {
      // retry the request since retries were specified and we got a status code we should retry on
      self.request(method, path, params, callback);
      return;
    } else {
      // pass the transport-level error to the caller
      err.statusCode = null
      err.code = null
      err.allErrors = [];
      helpers.attachBodyInfoToError(err, body)
      callback(err, body, response);
      return;
    }
  })
}

exports.makeCilError = function (message) {
  var err = new Error()
  if (message) {
    err.message = message
  }
  err.code = null
  err.allErrors = []
  err.cilterReply = null
  return err
}

module.exports = coveritlive
