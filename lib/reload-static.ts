import * as fs from 'fs';
import * as events from 'events';
import * as http from 'http';
import * as path from 'path';
import es from 'event-stream';
import mime from 'mime';
import minimatch from 'minimatch';
import {mstat} from './reload-static/util.js';
import debounce from 'lodash.debounce';

const pkg = JSON.parse(fs.readFileSync(
    new URL('../package.json', import.meta.url)
).toString());

const version = pkg.version.split('.');

function tryStat(p: fs.PathLike, callback: Callback) {
    try {
        fs.stat(p, callback);
    } catch (e) {
        callback(e);
    }
}

class Server {

    root: string;
    options: Server.Options
    cache: { [key: string]: number };
    defaultHeaders: Headers;
    serverInfo: string;
    defaultExtension: string | null

    constructor (root?: string | Server.Options, options?: Server.Options) {
        if (root && typeof root === 'object') {
            options = root;
            root = undefined;
        }

        // resolve() doesn't normalize (to lowercase) drive letters on Windows
        this.root    = path.normalize(path.resolve(root as string|| '.'));
        this.options = options || {} as any;
        this.cache   = {'**': 3600};

        this.defaultHeaders  = {};
        this.options.headers = this.options.headers || {};

        this.options.indexFile = this.options.indexFile || 'index.html';

        if ('cache' in this.options) {
            if (typeof(this.options.cache) === 'number') {
                this.cache = {'**': this.options.cache};
            } else if (typeof(this.options.cache) === 'object') {
                this.cache = this.options.cache;
            } else if (! this.options.cache) {
                this.cache = {};
            }
        }

        if ('serverInfo' in this.options && this.options.serverInfo) {
            this.serverInfo = this.options.serverInfo.toString();
        } else {
            this.serverInfo = 'node-static/' + version.join('.');
        }

        if ('defaultExtension' in this.options) {
            this.defaultExtension =  '.' + this.options.defaultExtension;
        } else {
            this.defaultExtension = null;
        }

        if (this.options.serverInfo !== null) {
            this.defaultHeaders['server'] = this.serverInfo;
        }

        for (const k in this.defaultHeaders) {
            this.options.headers[k] = this.options.headers[k] ||
                                      this.defaultHeaders[k];
        }

        this.options.wait = this.options.wait ?? 100;
        this.options.reloadPath = this.options.reloadPath ?? '/___reload___';
    }

    TAG_RE = new RegExp('</(body|svg|head)>', 'i');

    getHTML(path: string) {
        return `
<script type="text/javascript">
    // <![CDATA[  <-- For SVG support
    if ('WebSocket' in window) {
        (function() {
            function refreshCSS() {
                for (const link of [...document.getElementsByTagName("link")]
                    .filter(link => link.href && link.rel.toLowerCase() === 'stylesheet')
                ) {
                    const url = new URL(link.href);
                    const params = new URLSearchParams(url.search);
                    params.set('_noCache', new Date().valueOf());
                    url.search = params.toString();
                    link.href = url.toString();
                }
            }
            const eventSource = new EventSource('${path}');
            eventSource.onmessage = msg => {
                if (msg.data == 'reload') window.location.reload();
                else if (msg.data == 'refreshcss') refreshCSS();
            }
            console.log('Live reload enabled.');
        })();
    }
    // ]]>
</script>`;
    }

    isEventStream(request: http.IncomingMessage) {
        return !! request.headers.accept?.split(',')
            .map(h => h.trim())
            .includes('text/event-stream');
    }

    setReloadable(server: http.Server) {
        this.options.reload = this.getHTML(this.options.reloadPath);
        const clients = new Set<http.ServerResponse>();
        server.on('request', async (request, response) => {
            if (request.url && this.isEventStream(request)) {
                const url = new URL(request.url, `http://${request.headers.host}`);
                if (url.pathname === this.options.reloadPath) {
                    clients.add(response);
                    response.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    });
                    // prevent client "pending"
                    response.write('event: open\n\n'); // 2x CRLF are necessary to the protocol
                    response.on('close', () => clients.delete(response));
                }
            }
        });
        const dir = this.resolve('/');
        let cssChange: boolean | undefined;
        const notify = debounce(changePath => {
            console.log((cssChange ? 'CSS change' : 'Change') + ' detected', changePath);
            clients.forEach(client =>
                client.write(
                    `data: ${cssChange ? 'refreshcss' : 'reload'}

`) // 2x CRLF are necessary to the protocol
            );
        }, this.options.wait);
        (async () => {
            const watcher = fs.promises.watch(dir, { recursive: true });
            for await (const event of watcher) {
                const changePath = event.filename;
                cssChange = cssChange === undefined || cssChange
                    ? path.extname(changePath) === ".css" && !this.options.noCssInject
                    : false;
                notify(changePath);
            }
        })();
    }

    serveDir (
        pathname: string,
        req: http.IncomingMessage,
        res: http.ServerResponse,
        finish: Finish
    ) {
        const htmlIndex = path.join(pathname, this.options.indexFile),
            that = this;

        tryStat(htmlIndex, function (e, stat) {
            if (!e) {
                const status = 200;
                const headers = {};
                const originalPathname = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname);
                if (originalPathname.length && originalPathname.charAt(originalPathname.length - 1) !== '/') {
                    return finish(301, { 'Location': originalPathname + '/' });
                } else {
                    that.respond(null, status, headers, [htmlIndex], stat, req, res, finish);
                }
            } else {
                // Stream a directory of files as a single file.
                fs.readFile(path.join(pathname, 'index.json'), function (e, contents) {
                    if (e) { return finish(404, {}) }
                    const index = JSON.parse(contents.toString());
                    streamFiles(index.files);
                });
            }
        });
        function streamFiles(files: string[]) {
            mstat(pathname, files, function (e, stat) {
                if (e) { return finish(404, {}) }
                that.respond(pathname, 200, {}, files, stat, req, res, finish);
            });
        }
    }

    serveFile(
        pathname: string,
        status: number,
        headers: Headers,
        req: http.IncomingMessage,
        res: http.ServerResponse
    ): events.EventEmitter {
        const that = this;
        const promise = new(events.EventEmitter);
        pathname = this.resolve(pathname);

        tryStat(pathname, function (e, stat) {
            if (e) {
                return promise.emit('error', e);
            }
            that.respond(null, status, headers, [pathname], stat, req, res, function(status: number, headers?: Headers) {
                that.finish(status, headers!, req, res, promise);
            });
        });
        return promise;
    }

    finish(
        status: number,
        headers: Headers,
        req: http.IncomingMessage,
        res: http.ServerResponse,
        promise: events.EventEmitter,
        callback?: Callback
    ) {
        const result = {
            status,
            headers,
            message: http.STATUS_CODES[status]
        };

        if (this.options.serverInfo !== null) {
            headers['server'] = this.serverInfo;
        }

        if (!status || status >= 400) {
            if (callback) {
                callback(result);
            } else {
                if (promise.listeners('error').length > 0) {
                    promise.emit('error', result);
                }
                else {
                    res.writeHead(status, headers);
                    res.end();
                }
            }
        } else {
            // Don't end the request here, if we're streaming;
            // it's taken care of in `prototype.stream`.
            if (status !== 200 || req.method !== 'GET') {
                res.writeHead(status, headers);
                res.end();
            }
            callback && callback(null, result);
            promise.emit('success', result);
        }
    }

    servePath(
        pathname: string,
        status: number,
        headers: Headers,
        req: http.IncomingMessage,
        res: http.ServerResponse,
        finish: Finish
    ) {
        const that = this,
            promise = new(events.EventEmitter);

        pathname = this.resolve(pathname);

        // Make sure we're not trying to access a
        // file outside of the root.
        if (pathname.startsWith(that.root)) {
            tryStat(pathname, function (e, stat) {
                if (e) {
                    // possibly not found, check default extension
                    if (that.defaultExtension) {
                        tryStat(pathname + that.defaultExtension, function(e2, stat2) {
                            if (e2) {
                                // really not found
                                finish(404, {});
                            } else if (stat2.isFile()) {
                                that.respond(null, status, headers, [pathname+that.defaultExtension], stat2, req, res, finish);
                            } else {
                                finish(400, {});
                            }
                        });
                    } else {
                        finish(404, {});
                    }
                } else if (stat.isFile()) {      // Stream a single file.
                    that.respond(null, status, headers, [pathname], stat, req, res, finish);
                } else if (stat.isDirectory()) { // Stream a directory of files.
                    that.serveDir(pathname, req, res, finish);
                } else {
                    finish(400, {});
                }
            });
        } else {
            // Forbidden
            finish(403, {});
        }
        return promise;
    }

    resolve(pathname: string) {
        return path.resolve(path.join(this.root, pathname));
    }

    serve(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        callback?: Callback
    ) {
        if (! this.isEventStream(req)) {
            const that    = this,
                promise = new(events.EventEmitter);
            let pathname: string;

            const finish = function (status: number, headers: Headers) {
                that.finish(status, headers, req, res, promise, callback);
            };

            try {
                pathname = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname);
            }
            catch(e) {
                return process.nextTick(function() {
                    return finish(400, {});
                });
            }

            process.nextTick(function () {
                that.servePath(pathname, 200, {}, req, res, finish).on('success', function (result) {
                    promise.emit('success', result);
                }).on('error', function (err) {
                    promise.emit('error');
                });
            });
            if (! callback) { return promise }
        }
    }

    /* Check if we should consider sending a gzip version of the file based on the
     * file content type and client's Accept-Encoding header value.
     */
    gzipOk(req: http.IncomingMessage, contentType: string) {
        const enable = this.options.gzip;
        if(enable &&
            (typeof enable === 'boolean' ||
                (contentType && (enable instanceof RegExp) && enable.test(contentType)))) {
            const acceptEncoding = req.headers['accept-encoding'];
            return acceptEncoding && acceptEncoding.includes('gzip');
        }
        return false;
    }

    /* Send a gzipped version of the file if the options and the client indicate gzip is enabled and
     * we find a .gz file matching the static resource requested.
     */
    respondGzip(
        pathname: string | null,
        status: number,
        contentType: string,
        _headers: Headers,
        files: string[],
        stat: fs.Stats,
        req: http.IncomingMessage,
        res: http.ServerResponse,
        finish: Finish
    ) {
        const that = this;
        if (files.length == 1 && this.gzipOk(req, contentType)) {
            const gzFile = files[0] + '.gz';
            tryStat(gzFile, function (e, gzStat) {
                if (!e && gzStat.isFile()) {
                    const vary = _headers['Vary'];
                    _headers['Vary'] = (vary && vary != 'Accept-Encoding' ? vary + ', ' : '') + 'Accept-Encoding';
                    _headers['Content-Encoding'] = 'gzip';
                    stat.size = gzStat.size;
                    files = [gzFile];
                }
                that.respondNoGzip(pathname, status, contentType, _headers, files, stat, req, res, finish);
            });
        } else {
            // Client doesn't want gzip or we're sending multiple files
            that.respondNoGzip(pathname, status, contentType, _headers, files, stat, req, res, finish);
        }
    }

    parseByteRange(req: http.IncomingMessage, stat: fs.Stats) {
        const byteRange = {
            from: 0,
            to: 0,
            valid: false
        }
        let rangeHeader: string[] | string | undefined = req.headers['range'];
        const flavor = 'bytes=';

        if (rangeHeader) {
            if (rangeHeader.startsWith(flavor) && !rangeHeader.includes(',')) {
                /* Parse */
                rangeHeader = rangeHeader.substring(flavor.length).split('-');
                byteRange.from = parseInt(rangeHeader[0]);
                byteRange.to = parseInt(rangeHeader[1]);

                /* Replace empty fields of differential requests by absolute values */
                if (isNaN(byteRange.from) && !isNaN(byteRange.to)) {
                    byteRange.from = stat.size - byteRange.to;
                    byteRange.to = stat.size ? stat.size - 1 : 0;
                } else if (!isNaN(byteRange.from) && isNaN(byteRange.to)) {
                    byteRange.to = stat.size ? stat.size - 1 : 0;
                }

                /* General byte range validation */
                if (!isNaN(byteRange.from) && !isNaN(byteRange.to) && 0 <= byteRange.from && byteRange.from <= byteRange.to) {
                    byteRange.valid = true;
                } else {
                    console.warn('Request contains invalid range header: ', rangeHeader);
                }
            } else {
                console.warn('Request contains unsupported range header: ', rangeHeader);
            }
        }
        return byteRange;
    }

    respondNoGzip(
        pathname: string | null,
        status: number,
        contentType: string,
        _headers: Headers,
        files: string[],
        stat: fs.Stats,
        req: http.IncomingMessage,
        res: http.ServerResponse,
        finish: Finish
    ) {
        const mtime         = Date.parse(stat.mtime as any),
            key             = pathname || files[0],
            headers: Headers = {},
            clientETag      = req.headers['if-none-match'],
            clientMTime     = Date.parse(req.headers['if-modified-since']!),
            byteRange       = this.parseByteRange(req, stat);
        let startByte       = 0,
            length          = stat.size;

        /* Handle byte ranges */
        if (files.length == 1 && byteRange.valid) {
            if (byteRange.to < length) {

                // Note: HTTP Range param is inclusive
                startByte = byteRange.from;
                length = byteRange.to - byteRange.from + 1;
                status = 206;

                // Set Content-Range response header (we advertise initial resource size on server here (stat.size))
                headers['Content-Range'] = 'bytes ' + byteRange.from + '-' + byteRange.to + '/' + stat.size;

            } else {
                byteRange.valid = false;
                console.warn(req.url, 'Range request exceeds file boundaries, goes until byte no', byteRange.to, 'against file size of', length, 'bytes');
            }
        }

        /* In any case, check for unhandled byte range headers */
        if (!byteRange.valid && req.headers['range']) {
            console.error(req.url, new Error('Range request present but invalid, might serve whole file instead'));
        }

        // Copy default headers
        for (const k in this.options.headers) {  headers[k] = this.options.headers[k] }

        headers['Etag']          = JSON.stringify([stat.ino, stat.size, mtime].join('-'));
        headers['Date']          = new(Date)().toUTCString();
        headers['Last-Modified'] = new(Date)(stat.mtime).toUTCString();
        headers['Content-Type']   = contentType;
        headers['Content-Length'] = length;

        // Copy custom headers
        for (const k in _headers) { headers[k] = _headers[k] }

        // Conditional GET
        // If the "If-Modified-Since" or "If-None-Match" headers
        // match the conditions, send a 304 Not Modified.
        if ((clientMTime  || clientETag) &&
            (!clientETag  || clientETag === headers['Etag']) &&
            (!clientMTime || clientMTime >= mtime)) {
            // 304 response should not contain entity headers
            ['Content-Encoding',
                'Content-Language',
                'Content-Length',
                'Content-Location',
                'Content-MD5',
                'Content-Range',
                'Content-Type',
                'Expires',
                'Last-Modified'].forEach(function (entityHeader) {
                delete headers[entityHeader];
            });
            finish(304, headers);
        } else {
            this.writeStream(status, headers, key, files, length, startByte, res, finish);
        }
    }

    respond(
        pathname: string | null,
        status: number,
        _headers: Headers,
        files: string[],
        stat: fs.Stats,
        req: http.IncomingMessage,
        res: http.ServerResponse,
        finish: Finish
    ) {
        const contentType = _headers['Content-Type'] ||
                          mime.getType(files[0]) ||
                          'application/octet-stream';
        _headers = this.setCacheHeaders(_headers, req);

        if(this.options.gzip) {
            this.respondGzip(pathname, status, contentType, _headers, files, stat, req, res, finish);
        } else {
            this.respondNoGzip(pathname, status, contentType, _headers, files, stat, req, res, finish);
        }
    }

    writeStream(
        status: number,
        headers: Headers,
        pathname: string,
        files: string[],
        length: number,
        startByte: number,
        res: http.ServerResponse,
        finish: Finish
    ) {
        const cb = function (e: Error) {
            if (e) { return finish(500, {}) }
            finish(status, headers);
        }
        let willInject = false;
        if (this.options.reload) {
            const ext = path.extname(pathname).toLocaleLowerCase();
            if ([ ".html", ".htm", ".xhtml", ".svg" ].includes(ext)
                || ['text/html', 'image/svg+xml', 'application/xhtml+xml'].includes(headers['Content-Type'])
            ) {
                willInject = true;
            }
        }
        if (willInject) {
            delete headers['Content-Length'];
            res.writeHead(status, headers);
            this.stream(pathname, files, length, startByte, res, cb, file => {
                const stream = fs.createReadStream(file, {
                    flags: 'r',
                    mode: 0o666,
                    start: startByte,
                    end: startByte + (length ? length - 1 : 0)
                })
                let injected = false;
                const streamPipe = stream.pipe.bind(stream);
                stream.pipe = ((res: NodeJS.WritableStream) => {
                    streamPipe(es.split())
                        .pipe(es.map((line: string, consume: (err: Error | null, line: string) => void) => {
                            try {
                                if (! injected) {
                                    const match = this.TAG_RE.exec(line);
                                    if (match) {
                                        injected = true;
                                        line = line.slice(0, match.index) + this.options.reload + match[0];
                                    }
                                }
                            } finally {
                                consume(null, line);
                            }
                        }))
                        .pipe(res);
                }) as any;
                return stream;
            });
        } else {
            res.writeHead(status, headers);
            this.stream(pathname, files, length, startByte, res, cb);
        }
    }

    stream (
        pathname: string,
        files: string[],
        length: number,
        startByte: number,
        res: http.ServerResponse,
        callback: Callback,
        reader = (file: string) => fs.createReadStream(file, {
            flags: 'r',
            mode: 0o666,
            start: startByte,
            end: startByte + (length ? length - 1 : 0)
        })
    ) {
        (function streamFile(files, offset) {
            let file = files.shift();

            if (file) {
                file = path.resolve(file) === path.normalize(file)  ? file : path.join(pathname || '.', file);

                // Stream the file to the client
                reader(file).on('data', function (chunk) {
                    // Bounds check the incoming chunk and offset, as copying
                    // a buffer from an invalid offset will throw an error and crash
                    if (chunk.length && offset < length && offset >= 0) {
                        offset += chunk.length;
                    }
                }).on('close', function () {
                    streamFile(files, offset);
                }).on('error', function (err) {
                    callback(err);
                    console.error(err);
                }).pipe(res, { end: false });
            } else {
                res.end();
                callback(null, offset);
            }
        })(files.slice(0), 0);
    }

    setCacheHeaders(_headers: Headers, req: http.IncomingMessage) {
        const maxAge = this.getMaxAge(req.url!);
        if (typeof(maxAge) === 'number') {
            _headers['cache-control'] = 'max-age=' + maxAge;
        }
        return _headers;
    }

    getMaxAge(requestUrl: string) {
        if (this.cache) {
            for (const pattern in this.cache) {
                if (minimatch(requestUrl, pattern)) {
                    return this.cache[pattern];
                }
            }
        }
        return false;
    }
}

export interface Headers {
    [k: string]: any;
}
export type Finish = (status: number, headers: Headers) => void;
export type Callback = (error: any, result?: any) => void;

namespace Server {
    export interface Options {
        headers?: Headers
        indexFile: string
        cache?: number | boolean
        serverInfo?: Buffer
        server?: string
        "cache-control"?: string
        gzip? : RegExp

        defaultExtension?: string
        wait: number
        reload?: string
        reloadPath: string
        noCssInject?: boolean
    }
}

export {Server, version, mime};
