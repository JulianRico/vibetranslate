// store.js - Almacén en un archivo JSON con escritura atómica. Pensado para un solo proceso.
const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const r of data.licenses || []) this.records.set(r.id, r);
    }
  }

  all() {
    return [...this.records.values()];
  }

  get(id) {
    return this.records.get(id) || null;
  }

  find(pred) {
    for (const r of this.records.values()) if (pred(r)) return r;
    return null;
  }

  put(record) {
    this.records.set(record.id, record);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    const body = JSON.stringify({ licenses: this.all() }, null, 2);
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
