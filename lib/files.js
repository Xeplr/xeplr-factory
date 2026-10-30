// FILES a screen's fields hold.
//
// A `file` field stores ONE thing in its column: the PATH the upload answered
// with. The bytes are not in the database — they are in the folder of the
// tenant the request is for (@xeplr/actions' dataDir, under XEPLR_DATA_DIR),
// a folder per table:
//
//   <XEPLR_DATA_DIR>/<app>/<mtId1>/<mtId2>/screens/<table>/<id>__<original name>
//
// The column holds `<table>/<id>__<name>`, read back inside the reader's OWN
// folder: a path from another company names a file that is not in this one's.
//
// The id in front keeps two people's "scan.pdf" apart; the name after "__" is
// what the person sees in the form and gets back on download (fileLabel() in
// @xeplr/ui-factory reads it, on both sides).
//
// ── WHAT IS CHECKED, AND BY WHOM ─────────────────────────────────────────
// The field's OWN rules, from the published screen — `props.accept` (a list of
// extensions) and `props.maxSize` (megabytes) — never what the request says
// about itself. The EXTENSION is the authority: a browser's content type is the
// sender's word for it and can be anything, so it is not consulted at all.
//
// Nothing here serves a file to the world: the only way back out is the
// authenticated download route, which resolves the path inside the tenant's
// screens/ folder and refuses anything that climbs out of it.

var path = require('path');
var fs = require('fs');
var fsp = fs.promises;
var { generateId } = require('@xeplr/utils/lib/helpers');
var { dataDir } = require('@xeplr/actions');
var factoryModel = require('./model');

/** The folder in each tenant's own that a screen's files go in. */
var FOLDER = 'screens';

/** multer writes here first; a file only moves in once its field accepts it. */
var INCOMING = '.incoming';

/** Longest stem of a stored name — the whole path must fit varchar(255). */
var MAX_NAME = 80;

/**
 * @param records    the records store — resolve(screenKey)
 */
function createFilesStore(records, options) {
  options = options || {};
  // Gone, and said: a folder named here would put every company's files side by side.
  if (options.filesDir) throw new Error('@xeplr/factory: filesDir is gone — a screen\'s files are kept in each tenant\'s own folder under XEPLR_DATA_DIR (screens/).');
  var uploader = null;

  /** This request's tenant's screens/ folder, made if missing. */
  function dir() {
    var d = dataDir.resolve(FOLDER, 'The screens folder');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  /**
   * FileUploader for one file, made on the FIRST upload — so an app with no
   * file fields never needs multer (an optional peer) installed, and no
   * directory is created until something is actually uploaded.
   */
  async function uploadChain(fieldName) {
    var model = await factoryModel.load();
    if (!uploader) {
      var FileUploader = require('@xeplr/utils/lib/fileUploader');
      // Asked per upload: the folder is the requesting tenant's.
      uploader = new FileUploader({ destination: function() { return path.join(dir(), INCOMING); }, maxSize: model.MAX_FILE_MB * 1024 * 1024 });
    }
    return uploader.single(fieldName);
  }

  /** The `file` field named `field` on a published screen, with its rules. */
  async function fileField(screenKey, field) {
    var r = await records.resolve(screenKey);
    var node = r.model.inputNodes(r.fieldsDoc).find(function(n) { return n.props.name === field; });
    if (!node) throw notFound('Screen "' + screenKey + '" has no field "' + field + '"');
    if (node.type !== 'file') throw badRequest('"' + field + '" on "' + screenKey + '" is not a file field');
    return { r: r, node: node };
  }

  /**
   * An uploaded file, checked against its field's rules and moved into place.
   * Whatever is refused, the bytes multer already wrote are removed.
   * @returns {{ path, name, size }} — `path` is relative to the tenant's
   *          screens/ folder: the value the column stores.
   */
  async function store(screenKey, field, file) {
    if (!file) throw badRequest('No file was sent — the form field is "file"');
    try {
      var found = await fileField(screenKey, field);
      var node = found.node;
      var model = found.r.model;
      var label = node.props.label || field;

      var name = safeName(file.originalname);
      var accept = model.acceptList(node.props.accept);
      var ext = path.extname(name).toLowerCase();
      if (accept.length && accept.indexOf(ext) === -1) {
        throw badRequest('"' + label + '" takes ' + accept.join(', ') + ' — "' + file.originalname + '" is not one of them');
      }
      var maxMb = Number(node.props.maxSize) || model.MAX_FILE_MB;
      if (file.size > maxMb * 1024 * 1024) {
        throw badRequest('"' + label + '" takes files up to ' + maxMb + ' MB — this one is ' + mb(file.size) + ' MB');
      }

      var rel = [safeSegment(found.r.table), generateId() + '__' + name].join('/');
      var full = path.join(dir(), rel);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.rename(file.path, full);
      return { path: rel, name: file.originalname, size: file.size };
    } catch (err) {
      await discard(file.path);
      throw err;
    }
  }

  /**
   * A stored path → the file to send back, and the name to send it under.
   * Read inside the requesting tenant's own folder, so another company's path
   * names nothing here; one that climbs out is refused before anything is opened.
   */
  async function download(stored) {
    var full = inside(stored);
    var stat = await fsp.stat(full).catch(function() { return null; });
    if (!stat || !stat.isFile()) throw notFound('No such file');
    var model = await factoryModel.load();
    return { path: full, name: model.fileLabel(stored) };
  }

  /** The absolute path of a stored file — refused unless it is in this tenant's screens/ folder. */
  function inside(stored) {
    var base = dir();
    var full;
    try { full = dataDir.resolve(path.join(FOLDER, String(stored || '')), 'The file'); } catch (e) { full = null; }
    if (!full || full.indexOf(base + path.sep) !== 0) throw badRequest('That file is not in this app\'s files');
    return full;
  }

  function discard(temp) {
    if (!temp) return Promise.resolve();
    return fsp.unlink(temp).catch(function() { /* already gone, or never written */ });
  }

  return { dir: dir, uploadChain: uploadChain, fileField: fileField, store: store, download: download, inside: inside };
}

/**
 * A name safe to write and safe to read back: no directory of its own, nothing
 * but letters, digits, dot, dash and underscore, and short enough that the path
 * still fits the column.
 */
function safeName(original) {
  var base = String(original || '').split(/[\\/]/).pop();
  var cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  var ext = path.extname(cleaned).slice(0, 20);
  var stem = cleaned.slice(0, cleaned.length - path.extname(cleaned).length).slice(0, MAX_NAME);
  return (stem || 'file') + ext;
}

/** One folder name, from something that must not become two. */
function safeSegment(value) {
  var s = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  return s.slice(0, 64) || 'shared';
}

function mb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function badRequest(message) { var e = new Error(message); e.status = 400; return e; }
function notFound(message) { var e = new Error(message); e.status = 404; return e; }

module.exports = { createFilesStore: createFilesStore, safeName: safeName, safeSegment: safeSegment };
