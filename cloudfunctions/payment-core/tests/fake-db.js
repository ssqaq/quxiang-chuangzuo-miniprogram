"use strict";

function clone(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === "object") {
    return Object.keys(value).reduce((result, key) => {
      result[key] = clone(value[key]);
      return result;
    }, {});
  }
  return value;
}

function createFakeDb(seed = {}) {
  const collections = new Map();
  Object.entries(seed).forEach(([name, rows]) => {
    collections.set(name, new Map(Object.entries(rows).map(([id, value]) => (
      [id, Object.assign({ _id: id }, clone(value))]
    ))));
  });

  function collection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    const values = collections.get(name);
    return {
      doc(id) {
        return {
          async get() {
            const data = values.get(id);
            if (!data) {
              const error = new Error("document not found");
              error.code = "DATABASE_DOCUMENT_NOT_EXIST";
              throw error;
            }
            return { data: clone(data) };
          },
          async set({ data }) {
            values.set(id, Object.assign({ _id: id }, clone(data)));
            return { stats: { created: 1 } };
          },
          async update({ data }) {
            if (!values.has(id)) throw new Error("document not found");
            values.set(id, Object.assign({}, values.get(id), clone(data), { _id: id }));
            return { stats: { updated: 1 } };
          }
        };
      },
      where(condition) {
        let rows = Array.from(values.values()).filter((item) => Object.entries(condition).every(
          ([key, expected]) => item[key] === expected
        ));
        const chain = {
          limit(value) {
            rows = rows.slice(0, Number(value));
            return chain;
          },
          async get() {
            return { data: clone(rows) };
          }
        };
        return chain;
      }
    };
  }

  return {
    collection,
    async runTransaction(callback) {
      return callback({ collection });
    },
    read(name, id) {
      return clone(collections.get(name) && collections.get(name).get(id));
    },
    write(name, id, value) {
      if (!collections.has(name)) collections.set(name, new Map());
      collections.get(name).set(id, Object.assign({ _id: id }, clone(value)));
    }
  };
}

module.exports = { createFakeDb };
