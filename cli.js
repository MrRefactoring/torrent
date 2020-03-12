#!/usr/bin/env node

const minimist = require('minimist')
const fs = require('fs')
const path = require('path')
let logger = require('single-line-log').stdout
const bytes = require('pretty-bytes')

const pkg = require('./package.json')
const torrent = require('./')
const createTorrent = require('create-torrent')
const parseTorrent = require('parse-torrent')
const concat = require('concat-stream')
const humanSize = require('human-format')
const prettySeconds = require('pretty-seconds')

const argv = minimist(process.argv.slice(2), {
  alias: { outfile: 'o' }
})

if (argv.version) {
  console.log(pkg.version)
  process.exit(0)
}

if (argv.help || argv._.length === 0) {
  console.log(fs.readFileSync(path.resolve(__dirname, '/usage.txt'), 'utf-8'))
  process.exit(0)
}

if (argv.quiet) logger = function () { }

const source = argv._.shift()
let infile
if (source === 'create') {
  const dir = argv._.shift()
  let outfile = argv.outfile
  if (outfile === '-') outfile = null

  if (outfile && fs.existsSync(outfile)) {
    console.error('refusing to overwrite existing torrent file')
    process.exit(1)
  }

  const opts = {}
  if (argv.tracker) {
    if (typeof argv.tracker === 'string') opts.announceList = [[argv.tracker]]
    else opts.announceList = argv.tracker.map(function (t) { return [t] })
  }

  opts.urlList = argv.urlList

  createTorrent(dir, opts, function (err, torrent) {
    if (err) {
      console.error(err.stack)
      process.exit(1)
    } else if (outfile) {
      fs.writeFile(outfile, torrent, function (err) {
        if (err) {
          console.error(err.stack)
          process.exit(1)
        }
      })
    } else {
      process.stdout.write(torrent)
    }
  })
} else if (source === 'info') {
  infile = argv._.shift()
  getInfo(infile, function (parsed) {
    delete parsed.infoBuffer
    delete parsed.info.pieces
    console.log(JSON.stringify(toString(parsed), null, 2))

    function toString (obj) {
      if (Array.isArray(obj)) {
        return obj.map(toString)
      } else if (Buffer.isBuffer(obj)) {
        return obj.toString('utf8')
      } else if (typeof obj === 'object') {
        return Object.keys(obj).reduce(function (acc, key) {
          acc[key] = toString(obj[key])
          return acc
        }, {})
      } else return obj
    }
  })
} else if (source === 'ls' || source === 'list') {
  infile = argv._.shift()
  getInfo(infile, function (parsed) {
    parsed.files.forEach(function (file) {
      let prefix = ''
      if (argv.s && argv.h) {
        prefix = humanSize(file.length).replace(/(\d)B$/, '$1 B')
        prefix = Array(10 - prefix.length).join(' ') + prefix + ' '
      } else if (argv.s) {
        prefix = String(file.length)
        prefix = Array(10 - prefix.length).join(' ') + prefix + ' '
      }
      console.log(prefix + file.path)
    })
  })
} else if (source === 'seed') {
  infile = argv._.shift()
  const filename = infile
  if (!argv.path) argv.path = process.cwd()
  getSource(infile, function (body) {
    const dl = torrent(body, argv)
    dl.on('ready', function () {
      const seeding = dl.torrent.pieces.every(function (piece, i) {
        return dl.bitfield.get(i)
      })
      if (!seeding) {
        console.error('Missing files!')
        process.exit(1)
      } else {
        console.log('Verified files successfully!')
      }
      function status () {
        logger(
          'Seeding ' + filename + '\n' +
          'Connected to ' + dl.swarm.wires.reduce(notChoked, 0) + '/' + dl.swarm.wires.length + ' peers\n' +
          'Uploaded ' + bytes(dl.swarm.uploaded) + ' (' + bytes(dl.swarm.uploadSpeed()) + ')\n'
        )
      }
      setInterval(status, 1000)
      status()
    })
    dl.listen(0)
  })
} else {
  if (!argv.path) argv.path = process.cwd()

  getSource(source, function (body) {
    const dl = torrent(body, argv)

    dl.on('ready', function () {
      if (argv.peer) {
        console.log('connecting to peer', argv.peer)
        dl.connect(argv.peer)
      }

      const fileCount = dl.files.length
      const timeStart = (new Date()).getTime()
      console.log(fileCount.toString(), (fileCount === 1 ? 'file' : 'files'), 'in torrent')
      console.log(dl.files.map(function (f) { return f.name.trim() }).join('\n'))

      const status = function () {
        const down = bytes(dl.swarm.downloaded)
        const downSpeed = bytes(dl.swarm.downloadSpeed()) + '/s'
        const up = bytes(dl.swarm.uploaded)
        const upSpeed = bytes(dl.swarm.uploadSpeed()) + '/s'
        const torrentSize = dl.torrent.length
        const bytesRemaining = torrentSize - dl.swarm.downloaded
        let percentage = ((dl.swarm.downloaded / dl.torrent.length) * 100).toPrecision(4)
        let progressBar = ''
        const bars = ~~((percentage) / 5)

        let timeRemaining

        // (TimeTaken / bytesDownloaded) * bytesLeft=timeLeft
        if (dl.swarm.downloaded > 0) {
          if (dl.swarm.downloadSpeed() > 0) {
            const seconds = 1000
            const timeNow = (new Date()).getTime()
            const timeElapsed = timeNow - timeStart
            timeRemaining = (((timeElapsed / dl.swarm.downloaded) * bytesRemaining) / seconds).toPrecision(6)
            timeRemaining = 'Estimated ' + prettySeconds(~~timeRemaining) + ' remaining'
          } else {
            timeRemaining = 'Unknown time remaining'
          }
        } else {
          timeRemaining = 'Calculating'
        }

        if (percentage > 100) { percentage = 100 }

        for (let i = 0; i < bars; i++) {
          progressBar = progressBar + '='
        }

        progressBar = progressBar + Array(20 + 1 - progressBar.length).join(' ')

        logger(
          'Connected to ' + dl.swarm.wires.reduce(notChoked, 0) + '/' + dl.swarm.wires.length + ' peers\n' +
          'Downloaded ' + down + ' (' + downSpeed + ')\n' +
          'Uploaded ' + up + ' (' + upSpeed + ')\n' +
          'Torrent Size ' + bytes(torrentSize) + '\n\n' +
          'Complete: ' + percentage + '%\n' +
          '[' + progressBar + ']\n' +
          '0%    25   50   75   100%\n\n' + timeRemaining + '\n'
        )
      }

      setInterval(status, 500)
      status()
    })
  })
}

function notChoked (result, wire) {
  return result + (wire.peerChoking ? 0 : 1)
}

function getSource (infile, cb) {
  if (/^magnet:/.test(infile)) return cb(infile)
  const instream = !infile || infile === '-'
    ? process.stdin
    : fs.createReadStream(infile)
  instream.pipe(concat(cb))
}

function getInfo (infile, cb) {
  getSource(infile, function (body) {
    let parsed

    try {
      parsed = parseTorrent(body)
    } catch (err) {
      console.error(err.stack)
      process.exit(1)
    }
    cb(parsed)
  })
}
