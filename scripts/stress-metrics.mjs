export class Histogram {
  constructor() {
    this.bins = new Uint32Array(60001);
    this.count = 0;
    this.max = 0;
    this.sum = 0;
  }
  add(ms) {
    this.bins[Math.min(60000, Math.ceil(ms * 10))]++;
    this.count++;
    this.sum += ms;
    this.max = Math.max(this.max, ms);
  }
  percentile(p) {
    const target = Math.ceil(this.count * p);
    let total = 0;
    for (let i = 0; i < this.bins.length; i++) {
      total += this.bins[i];
      if (total >= target) return i / 10;
    }
    return 0;
  }
  snapshot() {
    return {
      count: this.count,
      p50: this.percentile(0.5),
      p90: this.percentile(0.9),
      p95: this.percentile(0.95),
      p99: this.percentile(0.99),
      max: this.max,
      mean: this.count ? this.sum / this.count : 0,
    };
  }
}
