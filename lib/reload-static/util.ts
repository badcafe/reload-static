import fs from 'fs';
import path from 'path';
import { Callback } from '../reload-static';

function mstat(dir: string, files: string[], callback: Callback) {
    (function mstat(files: string[], stats: fs.Stats[]) {
        const file = files.shift();

        if (file) {
            try {
                fs.stat(path.join(dir, file), function (e, stat) {
                    if (e) {
                        callback(e);
                    } else {
                        mstat(files, stats.concat([stat]));
                    }
                });
            } catch (e) {
                callback(e);
            }
        } else {
            callback(null, {
                size: stats.reduce(function (total, stat) {
                    return total + stat.size;
                }, 0),
                mtime: stats.reduce(function (latest, stat) {
                    return latest > (stat.mtime as any) ? latest : stat.mtime as any as number;
                }, 0),
                ino: stats.reduce(function (total, stat) {
                    return total + stat.ino;
                }, 0)
            });
        }
    })(files.slice(0), []);
}

export {mstat};
