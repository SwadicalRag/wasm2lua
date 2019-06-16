
import {ArrayMap} from "./arraymap"
import { VirtualRegisterManager, VirtualRegister, PhantomRegister } from "./virtualregistermanager";

export interface WASMModuleState {
    funcStates: WASMFuncState[];
    funcMinificationLookup: Map<string,string>;
    exportMinificationLookup: Map<string,string>;
    funcByName: Map<string,WASMFuncState>;
    funcByNameRaw: Map<string,WASMFuncState>;
    memoryAllocations: ArrayMap<string>;
    func_tables: Array< Array< Array<Index> > >;

    funcIdentGen: () => string;
    exportIdentGen: () => string;

    nextGlobalIndex: number;
}

export interface WASMFuncState {
    id: string;
    origID: string;
    regManager: VirtualRegisterManager;
    insLastRefs: number[];
    insLastAssigned: [number,WASMBlockState | false][];
    insCountPass1: number;
    insCountPass2: number;
    insCountPass1LoopLifespanAdjs: Map<number,WASMBlockState>;
    forceVarInit: Map<number, number[]>,
    registersToBeFreed: VirtualRegister[];
    locals: VirtualRegister[];
    localTypes: Valtype[];
    blocks: WASMBlockState[];
    funcType?: Signature;
    modState?: WASMModuleState;

    hasSetjmp: boolean;
    setJmps: CallInstruction[];

    labels: Map<string,{ins: number,id: number}>;
    gotos: {ins: number,label: string}[];
    jumpStreamEnabled: boolean;
    curJmpID: number;

    usedLabels: {[labelID: string]: boolean};

    stackLevel: number;
    stackData: (string | VirtualRegister | PhantomRegister | false)[];
}

export interface WASMBlockState {
    id: string;
    blockType: "block" | "loop" | "if";
    resultRegister?: VirtualRegister;
    resultType?: Valtype | null;
    insCountStart: number;
    enterStackLevel: number; // used to check if we left a block with an extra item in the stack
    hasClosed?: true;
}
