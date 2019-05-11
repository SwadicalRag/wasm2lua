export class ArrayMap<T> extends Map<string | number,T> {
    numSize = 0;

    set(k: string | number,v: T) {
        super.set(k,v);

        if(typeof k === "number") {
            if(k === this.numSize) {
                if((typeof v !== "undefined") && (v !== null)) {
                    this.numSize++;
                }
            }
            else if(k === (this.numSize - 1)) {
                if((typeof v === "undefined") || (v === null)) {
                    this.numSize--;
                }
            }
        }

        return this;
    }

    push(v: T) {
        this.set(this.numSize,v);
    }

    pop() {
        super.set(this.numSize - 1,undefined);
    }
}
