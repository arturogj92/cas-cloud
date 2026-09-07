export class LatestValueWriter<T> {
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(private write: (value: T) => Promise<void>) {}

  set(value: T) {
    const revision = ++this.revision;
    const done = this.pending.then(async () => {
      if (revision === this.revision) await this.write(value);
    });
    this.pending = done.catch(() => {});
    return done.then(() => revision === this.revision);
  }
}
