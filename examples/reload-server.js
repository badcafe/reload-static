import http from 'http';
import * as statik from '../dist/reload-static.cjs';

//
// Create a node-static server to serve the current directory
//
const file = new statik.Server('.', { cache: 7200, headers: {'X-Hello':'World!'} });

const server = http.createServer(function (request, response) {
    file.serve(request, response, function (err, res) {
        if (err) { // An error has occurred
            console.error("> Error serving " + request.url + " - " + err.message);
            response.writeHead(err.status, err.headers);
            response.end();
        } else { // The file was served successfully
            console.log("> " + request.url + " - " + res.message);
        }
    });
}).listen(8080);
if (process.env.NODE_ENV === 'development') {
    file.setReloadable(server);
}

console.log("> node-static is listening on http://127.0.0.1:8080");
console.log("> VISIT http://127.0.0.1:8080/examples/test.html");
