const {assert} = require('chai');

const statik = require('../../dist/reload-static.cjs');

describe('reload-static (CommonJS)', function () {
    it('Has expected properties', function () {
        assert.isArray(statik.version, '`version` is an array');
        assert.isFunction(statik.Server, '`Server` is a constructor');
        assert.isFunction(statik.mime.getType, '`mime.getType` is a function');
    });
});
