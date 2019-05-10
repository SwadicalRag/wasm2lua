"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class ArrayMap extends Map {
    constructor() {
        super(...arguments);
        this.numSize = 0;
    }
    set(k, v) {
        super.set(k, v);
        if (typeof k === "number") {
            if (k === this.numSize) {
                if ((typeof v !== "undefined") && (v !== null)) {
                    this.numSize++;
                }
            }
            else if (k === (this.numSize - 1)) {
                if ((typeof v === "undefined") || (v === null)) {
                    this.numSize--;
                }
            }
        }
        return this;
    }
    push(v) {
        this.set(this.numSize, v);
    }
    pop() {
        super.set(this.numSize - 1, undefined);
    }
}
exports.ArrayMap = ArrayMap;
//# sourceMappingURL=arraymap.js.map