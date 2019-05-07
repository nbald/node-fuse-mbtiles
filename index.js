var constants = require("constants");

var fs = require("fs"),
    path = require("path");

var fuse = require('fuse-bindings'),
    MBTiles = require('@mapbox/mbtiles');

// TODO require these arguments
var args = process.argv.slice(2),
    filename = path.resolve(args.shift()),
    mountPoint = path.resolve(args.shift());

var tileStore;

/**
 * Convert a path into XYZ coords.
 */
var lookup = function(path) {
  var parts = path.split("/", 4);

  if (parts[1]) {
    var z = Number(parts[1]);
  }

  if (parts[2]) {
    var x = Number(parts[2]);
  }

  if (parts[3]) {
    var y = Number(parts[3].split(".")[0]);
  }

  return {
    z: z,
    x: x,
    y: y
  };
};

/**
 * getattr() system call handler.
 */
var getattr = function(path, callback) {
  var stat = {};
  var info = lookup(path);

  if (Number.isNaN(info.z) || Number.isNaN(info.z) || Number.isNaN(info.x)) {
    return callback(-constants.ENOENT);
  }

  const isADirectory = !Number.isInteger(info.y);

  info.x = Number.isInteger(info.x) ? info.x : 0;
  info.y = Number.isInteger(info.y) ? info.y : 0;
  info.z = Number.isInteger(info.z) ? info.z : 0;

  stat.atime = new Date();
  stat.mtime = new Date();
  stat.ctime = new Date();
  stat.uid = process.getuid ? process.getuid() : 0;
  stat.gid = process.getgid ? process.getgid() : 0;

  tileStore.getTile(info.z, info.x, info.y, function(err, tile, options) {
    if (err) {
      console.warn(err, info);
      callback(-constants.ENOENT);
      return;
    }

    if (isADirectory) {
      stat.size = 4096; // standard size of a directory
      stat.mode = 040755; // directory with 755 permissions
    } else {
      if (tile.length === 0) return callback(-constants.ENOENT);
      stat.size = tile.length;
      stat.mode = 0100644; // file with 444 permissions
    }

    callback(0, stat);
  });
  return
};

var readdir = function(path, callback) {
  var info = lookup(path);
  if (info.y !== undefined) {
    callback(-constants.EINVAL); // this is a file
    return;
  }

  if (info.x !== undefined) {
    var query = tileStore._db.prepare("SELECT max(length(tile_data)) as max_size, tile_row FROM tiles WHERE tile_column = ? AND zoom_level = ? GROUP BY tile_row", function(err) {
      if (err) {
        console.warn("readdir:", err, info);
        callback(-constants.EINVAL);
        return;
      }

      query.all(info.x, info.z, function(err, rows) {
        var names = rows
        .filter(function(x) {
          return x.max_size > 0;
        })
        .map(function(x) {
          var y = (1 << info.z) - 1 - x.tile_row;
          // TODO get format from info
          return String(y) + ".png";
        });

        callback(0, names);
      });
    });

    return;
  }

  if (info.z !== undefined) {
    var query = tileStore._db.prepare("SELECT DISTINCT tile_column FROM tiles WHERE zoom_level = ?", function(err) {
      if (err) {
        console.warn(err, info);
        callback(-constants.EINVAL);
        return;
      }

      query.all(info.z, function(err, rows) {
        var names = rows.map(function(x) {
          return String(x.tile_column);
        });
        if (names.length === 0) {
          return callback(fuse.ENOENT);
        }

        callback(0, names);
      });
    });

    return;
  }

  // TODO use (cached) getInfo to determine this
  tileStore._db.all("SELECT DISTINCT zoom_level FROM tiles", function(err, rows) {
    var names = rows.map(function(x) {
      return String(x.zoom_level);
    });

    callback(0, names);
  });
};

/**
 * open() system call handler.
 */
var open = function(path, flags, callback) {
  var err = 0;
  var info = lookup(path);

  if (info.y === undefined) {
    err = -constants.ENOENT;
  }

  callback(err);
};

/**
 * read() system call handler.
 */
var read = function(path, fh, buf, len, offset, callback) {
  var err = 0;
  var info = lookup(path);
  var maxBytes;
  var data;

  if (info.y !== undefined) {
    tileStore.getTile(info.z, info.x, info.y, function(err, tile, options) {
      if (err) {
        console.warn(err, info);
        callback(-constants.ENOENT);
        return;
      }

      if (offset < tile.length) {
        maxBytes = tile.length - offset;
        if (len > maxBytes) {
          len = maxBytes;
        }
        tile.copy(buf, 0, offset, offset + len);
        err = len;
      }

      callback(err);
    });
  } else {
    callback(-constants.EPERM); // a directory
  }
};

/**
 * release() system call handler.
 */
var release = function(path, fh, callback) {
  callback(0);
};

var init = function(callback) {
  new MBTiles(filename, function(err, mbtiles) {
    if (err) throw err;
    tileStore = mbtiles;
    mbtiles.getInfo(function(err, info) {
      if (err) throw err;

      console.log("tileStore initialized.");
      console.log(info);
      callback();
    });
  });
};

var destroy = function(callback) {
  tileStore.close(callback);
};

var statfs = function(path, callback) {
  return callback(0, {
    bsize: 1000000,
    frsize: 1000000,
    blocks: 1000000,
    bfree: 1000000,
    bavail: 1000000,
    files: 1000000,
    ffree: 1000000,
    favail: 1000000,
    fsid: 1000000,
    flag: 1000000,
    namemax: 1000000
  });
};

var mkdir = function(path, mode, callback) {
  // TODO do we need to check if path already exists?
  var info = lookup(path);

  if (
    Number.isNaN(info.z) ||
    Number.isNaN(info.z) ||
    Number.isNaN(info.x)
  ) {
    return callback(-constants.EINVAL);
  }

  info.x = Number.isInteger(info.x) ? info.x : 0;
  info.y = Number.isInteger(info.y) ? info.y : 0;
  info.z = Number.isInteger(info.z) ? info.z : 0;

  const emptyTile = new Buffer(0);

  tileStore.startWriting(function(err) {
    if (err) throw err;
    tileStore.putTile(info.z, info.x, info.y, emptyTile, function(err) {
      if (err) throw err;
      tileStore.stopWriting(function(err) {
        if (err) throw err;
        return callback(0)
      });
    })
  });
}

var options = {
  force: true,
  getattr: getattr,
  readdir: readdir,
  open: open,
  read: read,
  // write: write,
  release: release,
  // create: create,
  // unlink: unlink,
  // rename: rename,
  mkdir: mkdir,
  // rmdir: rmdir,
  init: init,
  destroy: destroy,
  statfs: statfs
};

fs.mkdir(mountPoint, function(err) {
  if (err && err.code !== "EEXIST") {
    throw err;
  }

  fuse.mount(mountPoint, options, function (err) {
    if (err) throw err
    console.log('filesystem mounted on ' + mountPoint)
  })

});

process.on('SIGINT', function () {
  fuse.unmount(mountPoint, function (err) {
    if (err) {
      console.log('filesystem at ' + mountPoint + ' not unmounted', err)
    } else {
      console.log('filesystem at ' + mountPoint + ' unmounted')
    }
  })
})
