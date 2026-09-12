function fakeFirestore(options = {}) {
  const values = new Map();
  let transactionTail = Promise.resolve();
  let transactionAttempts = 0;
  let retryPending = options.retryFirstTransaction === true;
  class Reference {
    constructor(path) { this.path = path; }
    collection(name) { return new Collection(`${this.path}/${name}`); }
    async get() { return snapshot(this.path); }
    async set(value) { values.set(this.path, structuredClone(value)); }
    async create(value) { if (values.has(this.path)) throw new Error("already_exists"); values.set(this.path, structuredClone(value)); }
  }
  class Collection {
    constructor(path) { this.path = path; }
    doc(id) { return new Reference(`${this.path}/${id}`); }
    orderBy(field, direction) {
      return { get: async () => ({ docs: [...values.keys()].filter(path => path.startsWith(`${this.path}/`) && !path.slice(this.path.length + 1).includes("/")).map(snapshot).sort((a, b) => (a.data()[field] - b.data()[field]) * (direction === "desc" ? -1 : 1)) }) };
    }
  }
  function snapshot(path) { return { id: path.split("/").at(-1), exists: values.has(path), data: () => structuredClone(values.get(path)) }; }
  const db = {
    collection(name) { return new Collection(name); },
    runTransaction(callback) {
      const run = transactionTail.then(async () => {
      const attempt = async () => {
        transactionAttempts += 1;
        const writes = [];
        const result = await callback({
          get: async reference => snapshot(reference.path),
          create: (reference, value) => writes.push(["create", reference.path, value]),
          set: (reference, value) => writes.push(["set", reference.path, value])
        });
        return { result, writes };
      };
      if (retryPending) {
        retryPending = false;
        await attempt(); // Firestore may discard a callback result after contention.
      }
      const { result, writes } = await attempt();
      writes.forEach(([operation, path, value]) => { if (operation === "create" && values.has(path)) throw new Error("already_exists"); values.set(path, structuredClone(value)); });
      return result;
      });
      transactionTail = run.catch(() => undefined);
      return run;
    }
  };
  return { db, values, getTransactionAttempts: () => transactionAttempts };
}

module.exports={fakeFirestore};
