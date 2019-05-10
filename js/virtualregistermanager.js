"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
;
class VirtualRegisterManager {
    constructor() {
        this.registerCache = [];
        this.registers = [];
        this.namedRegisters = new Map();
    }
    getNextFreeRegisterID() {
        for (let i = 0; i < this.registers.length; i++) {
            if (this.registers[i].id != i) {
                return i;
            }
        }
        return this.registers.length;
    }
    getPhysicalRegisterName(reg) { return `reg${reg.id}`; }
    createRegister(name) {
        let reg = {
            id: this.getNextFreeRegisterID(),
            name,
            refs: 0,
        };
        this.namedRegisters.set(name, reg);
        this.registers.push(reg);
        this.registerCache.push(reg);
        this.totalRegisters = Math.max(this.registers.length);
        this.registers.sort((a, b) => {
            return a.id - b.id;
        });
        return reg;
    }
    createTempRegister() {
        let reg = {
            id: this.getNextFreeRegisterID(),
            name: "temp",
            refs: 0,
        };
        this.registers.push(reg);
        this.registerCache.push(reg);
        this.totalRegisters = Math.max(this.registers.length);
        this.registers.sort((a, b) => {
            return a.id - b.id;
        });
        return reg;
    }
    refRegister(reg) {
        reg.refs++;
    }
    unrefRegister(reg) {
        reg.refs--;
        if (reg.refs <= 0) {
            this.freeRegister(reg);
        }
    }
    freeRegister(reg) {
        this.namedRegisters.delete(reg.name);
        let id = this.registers.indexOf(reg);
        if (id !== -1) {
            this.registers.splice(id);
        }
    }
}
exports.VirtualRegisterManager = VirtualRegisterManager;
//# sourceMappingURL=virtualregistermanager.js.map