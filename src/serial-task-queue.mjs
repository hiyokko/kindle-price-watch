export function createSerialTaskQueue() {
  let tail = Promise.resolve();

  return function enqueue(task) {
    const operation = tail.catch(() => {}).then(task);
    tail = operation.catch(() => {});
    return operation;
  };
}
