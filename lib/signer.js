// Copyright 2012 Joyent, Inc.  All rights reserved.

var assert = require('assert-plus');
var crypto = require('crypto');
var http = require('http');
var debugHttpSignature = require('debug')('http-signature');
var sprintf = require('util').format;



///--- Globals

var Algorithms = {
  'rsa-sha1': true,
  'rsa-sha256': true,
  'rsa-sha512': true,
  'dsa-sha1': true,
  'hmac-sha1': true,
  'hmac-sha256': true,
  'hmac-sha512': true
};

var DraftOptions = {
      '04' : {
        specialHeader: '(request-target)',
        sigHeaderTemplate: 'keyId="%s",algorithm="%s",headers="%s",signature="%s"',
        sigHeaderName : 'Signature'
      },

      '03' : {
        specialHeader: '(request-target)',
        sigHeaderTemplate: 'keyId="%s",algorithm="%s",headers="%s",signature="%s"',
        sigHeaderName : 'Signature'
      },

      '01' : {
        specialHeader: 'request-line',
        sigHeaderTemplate: 'Signature keyId="%s",algorithm="%s",headers="%s",signature="%s"',
        sigHeaderName : 'Authorization'
      }
    };



///--- Specific Errors

function MissingHeaderError(message) {
    this.name = 'MissingHeaderError';
    this.message = message;
    this.stack = (new Error()).stack;
}
MissingHeaderError.prototype = new Error();


function InvalidAlgorithmError(message) {
    this.name = 'InvalidAlgorithmError';
    this.message = message;
    this.stack = (new Error()).stack;
}
InvalidAlgorithmError.prototype = new Error();

function InvalidDraftError(message) {
    this.name = 'InvalidDraftError';
    this.message = message;
    this.stack = (new Error()).stack;
}
InvalidDraftError.prototype = new Error();



///--- Internal Functions

function _pad(val) {
  if (parseInt(val, 10) < 10) {
    val = '0' + val;
  }
  return val;
}


function _rfc1123() {
  var date = new Date();

  var months = ['Jan',
                'Feb',
                'Mar',
                'Apr',
                'May',
                'Jun',
                'Jul',
                'Aug',
                'Sep',
                'Oct',
                'Nov',
                'Dec'];
  var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[date.getUTCDay()] + ', ' +
    _pad(date.getUTCDate()) + ' ' +
    months[date.getUTCMonth()] + ' ' +
    date.getUTCFullYear() + ' ' +
    _pad(date.getUTCHours()) + ':' +
    _pad(date.getUTCMinutes()) + ':' +
    _pad(date.getUTCSeconds()) +
    ' GMT';
}



///--- Exported API

module.exports = {

  /**
   * Adds an 'Authorization' header to an http.ClientRequest object.
   *
   * Note that this API will add a Date header if it's not already set. Any
   * other headers in the options.headers array MUST be present, or this
   * will throw.
   *
   * You shouldn't need to check the return type; it's just there if you want
   * to be pedantic.
   *
   * @param {Object} request an instance of http.ClientRequest.
   * @param {Object} options signing parameters object:
   *                   - {String} keyId required.
   *                   - {String} key required (either a PEM or HMAC key).
   *                   - {Array} headers optional; defaults to ['date'].
   *                   - {String} algorithm optional; defaults to 'rsa-sha256'.
   *                   - {String} httpVersion optional; defaults to '1.1'.
   *                   - {String} draft optional; '03' or '01', defaults to '01'.
   * @return {Boolean} true if Authorization (and optionally Date) were added.
   * @throws {TypeError} on bad parameter types (input).
   * @throws {InvalidAlgorithmError} if algorithm was bad.
   * @throws {InvalidDraftError} if draft was bad.
   * @throws {MissingHeaderError} if a header to be signed was specified but
   *                              was not present.
   */
  signRequest: function signRequest(request, options) {
    assert.object(request, 'request');
    assert.object(options, 'options');
    assert.optionalString(options.algorithm, 'options.algorithm');
    assert.string(options.keyId, 'options.keyId');
    assert.optionalArrayOfString(options.headers, 'options.headers');
    assert.optionalString(options.httpVersion, 'options.httpVersion');
    assert.optionalString(options.draft, 'options.draft');

    if (!request.getHeader('Date'))
      request.setHeader('Date', _rfc1123());
    if (!options.headers)
      options.headers = ['date'];
    if (!options.algorithm)
      options.algorithm = 'rsa-sha256';
    if (!options.httpVersion)
      options.httpVersion = '1.1';

    if (!options.draft)
      options.draft = '04';

    if (!DraftOptions[options.draft])
      throw new InvalidDraftError('draft ' + options.draft + ' is not supported');

    options.algorithm = options.algorithm.toLowerCase();

    if (!Algorithms[options.algorithm])
      throw new InvalidAlgorithmError(options.algorithm + ' is not supported');

    var i;
    var stringToSign = '';
    var specialHeader = DraftOptions[options.draft].specialHeader;
    debugHttpSignature('signing headers: %s\n', JSON.stringify(options.headers));
    for (i = 0; i < options.headers.length; i++) {
      if (typeof (options.headers[i]) !== 'string')
        throw new TypeError('options.headers must be an array of Strings');

      var h = options.headers[i].toLowerCase();

      if (h !== specialHeader) {
        var value = request.getHeader(h);
        if (!value) {
          throw new MissingHeaderError(h + ' was not in the request');
        }
        stringToSign += h + ': ' + value;
      } else {
        if (options.draft === '01')
          stringToSign +=
            request.method + ' ' + request.path + ' HTTP/' + options.httpVersion;
        else // all others
          stringToSign += h + ': ' + request.method.toLowerCase() + ' ' + request.path;
      }

      if ((i + 1) < options.headers.length)
        stringToSign += '\n';
    }

    debugHttpSignature('string to sign: %s\n', stringToSign);

    var alg = options.algorithm.match(/(hmac|rsa)-(\w+)/);
    var signature;
    if (alg[1] === 'hmac') {
      debugHttpSignature('alg: %s\n', alg);
      var hmac = crypto.createHmac(alg[2].toUpperCase(), options.key);
      hmac.update(stringToSign);
      signature = hmac.digest('base64');
    } else {
      debugHttpSignature('alg: %s\n', alg);
      var signer = crypto.createSign(options.algorithm.toUpperCase());
      signer.update(stringToSign);
      signature = signer.sign(options.key, 'base64');
    }

    var sigHeader = DraftOptions[options.draft].sigHeaderName,
        hdrTemplate = DraftOptions[options.draft].sigHeaderTemplate;

    request.setHeader(sigHeader, sprintf(hdrTemplate,
                                               options.keyId,
                                               options.algorithm,
                                               options.headers.join(' '),
                                               signature));
    return true;
  }

};
