// A small seeded random number generator, so the same quiz settings give the same questions.

export class Random {
  constructor(seed = Date.now()) {
    this.state = (Math.abs(Math.floor(seed)) % 2147483647) + 1;
  }

  /** A float in [0, 1) (mulberry32). */
  random() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n) {
    return Math.floor(this.random() * n);
  }

  /** Shuffle an array in place (Fisher-Yates) and return it. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  choice(arr) {
    return arr[this.int(arr.length)];
  }
}
