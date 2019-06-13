export interface VirtualRegister {
    id: number;
    name: string;

    isPhantom: false,

    firstRef?: number;
    lastRef?: number;

    stackEntryCount: number;

    // UNUSED
    refs: number;
};

export interface PhantomRegister {
    name: "temp";

    isPhantom: true,

    stackEntryCount: number;

    nestingDepth: number;
    value: string;
    dependencies: VirtualRegister[];
};


export class VirtualRegisterManager {
    registerCache: VirtualRegister[] = [];
    registers: VirtualRegister[] = [];
    namedRegisters = new Map<string,VirtualRegister>();

    virtualDisabled = false;

    totalRegisters: number = 0;
    static MAX_REG = 195;

    getNextFreeRegisterID() {
        // assumes this.registers is sorted by ASC

        for(let i=0;i < this.registers.length;i++) {
            if(this.registers[i].id != i) {
                return i;
            }
        }

        return this.registers.length;
    }

    getPhysicalRegisterName(reg: VirtualRegister) {
        if(this.virtualDisabled) {
            if(reg.name === "temp") {
                return `tmp${reg.id}`;
            }
            else {
                return reg.name;
            }
        }
        else {
            if(reg.id >= VirtualRegisterManager.MAX_REG) {
                return `vreg[${reg.id - VirtualRegisterManager.MAX_REG + 1}]`;
            }
            else {
                return `reg${reg.id}`;
            }
        }
    }

    createRegister(name: string) {
        let reg: VirtualRegister = {
            id: this.getNextFreeRegisterID(),
            name,
            refs: 0,
            stackEntryCount: 0,

            isPhantom: false,
        };

        this.namedRegisters.set(name,reg);
        this.registers.push(reg);
        this.registerCache.push(reg);

        this.totalRegisters = Math.max(this.totalRegisters,this.registers.length);
        this.registers.sort((a,b) => {
            return a.id - b.id;
        });

        return reg;
    }

    createPhantomRegister() {
        let reg: PhantomRegister = {
            name: "temp",

            isPhantom: true,

            stackEntryCount: 0,

            nestingDepth: 0,
            value: null,
            dependencies: [],
        };

        return reg;
    }

    realizePhantomRegister(preg: PhantomRegister) {
        let reg: VirtualRegister = {
            id: this.getNextFreeRegisterID(),
            name: "temp",
            refs: 0,
            stackEntryCount: preg.stackEntryCount,

            isPhantom: false,
        };

        this.registers.push(reg);
        this.registerCache.push(reg);

        this.totalRegisters = Math.max(this.totalRegisters,this.registers.length);
        this.registers.sort((a,b) => {
            return a.id - b.id;
        });

        return reg;
    }

    createTempRegister() {
        let reg: VirtualRegister = {
            id: this.getNextFreeRegisterID(),
            name: "temp",
            refs: 0,
            stackEntryCount: 0,

            isPhantom: false,
        };

        this.registers.push(reg);
        this.registerCache.push(reg);

        this.totalRegisters = Math.max(this.totalRegisters,this.registers.length);
        this.registers.sort((a,b) => {
            return a.id - b.id;
        });

        return reg;
    }

    // reffing/dereffing. Not sure what this should be used for but i think we may need it in the future
    refRegister(reg: VirtualRegister) {
        reg.refs++;
    }

    unrefRegister(reg: VirtualRegister) {
        reg.refs--;
        if(reg.refs <= 0) {
            this.freeRegister(reg);
        }
    }

    freeRegister(reg: VirtualRegister) {
        if(this.virtualDisabled) {return;}
        
        this.namedRegisters.delete(reg.name);
        let id = this.registers.indexOf(reg);
        if(id !== -1) {
            this.registers.splice(id,1);
        }
    }
}
