const torrents = require('torrent-stream')

module.exports = (source, opts) => {
  const engine = torrents(source, opts)

  engine.on('ready', () => {
    engine.files.forEach((file) => {
      file.select()
    })
  })

  return engine
}
