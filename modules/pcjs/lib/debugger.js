/**
 * @fileoverview Implements the PCjs Debugger component.
 * @author <a href="mailto:Jeff@pcjs.org">Jeff Parsons</a>
 * @version 1.0
 * Created 2012-Jun-21
 *
 * Copyright © 2012-2015 Jeff Parsons <Jeff@pcjs.org>
 *
 * This file is part of PCjs, which is part of the JavaScript Machines Project (aka JSMachines)
 * at <http://jsmachines.net/> and <http://pcjs.org/>.
 *
 * PCjs is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 *
 * PCjs is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with PCjs.  If not,
 * see <http://www.gnu.org/licenses/gpl.html>.
 *
 * You are required to include the above copyright notice in every source code file of every
 * copy or modified version of this work, and to display that copyright notice on every screen
 * that loads or runs any version of this software (see Computer.sCopyright).
 *
 * Some PCjs files also attempt to load external resource files, such as character-image files,
 * ROM files, and disk image files. Those external resource files are not considered part of the
 * PCjs program for purposes of the GNU General Public License, and the author does not claim
 * any copyright as to their contents.
 */

"use strict";

if (DEBUGGER) {
    if (typeof module !== 'undefined') {
        var str         = require("../../shared/lib/strlib");
        var usr         = require("../../shared/lib/usrlib");
        var web         = require("../../shared/lib/weblib");
        var Component   = require("../../shared/lib/component");
        var Interrupts  = require("./interrupts");
        var Messages    = require("./messages");
        var Bus         = require("./bus");
        var Memory      = require("./memory");
        var Keyboard    = require("./keyboard");
        var State       = require("./state");
        var CPU         = require("./cpu");
        var X86         = require("./x86");
        var X86Seg      = require("./x86seg");
    }
}

/**
 * Debugger Address Object
 *
 *      off             offset, if any
 *      sel             selector, if any (if null, addr should be set to a linear address)
 *      addr            linear address, if any (if null, addr will be recomputed from sel:off)
 *      type            one of the Debugger.ADDR.* values
 *      fData32         true if 32-bit operand size in effect
 *      fAddr32         true if 32-bit address size in effect
 *      cOverrides      non-zero if any overrides were processed with this address
 *      fComplete       true if a complete instruction was processed with this address
 *      fTempBreak      true if this is a temporary breakpoint address
 *      sCmd            set for breakpoint addresses if there's an associated command string
 *      aCmds           preprocessed commands (from sCmd)
 *
 * @typedef {{
 *      off:(number|null|undefined),
 *      sel:(number|null|undefined),
 *      addr:(number|null|undefined),
 *      type:(number|undefined),
 *      fData32:(boolean|undefined),
 *      fAddr32:(boolean|undefined),
 *      cOverrides:(number|undefined),
 *      fComplete:(boolean|undefined),
 *      fTempBreak:(boolean|undefined),
 *      sCmd:(string|undefined),
 *      aCmds:(Array.<string>|undefined)
 * }}
 */
var DbgAddr;

/**
 * Debugger(parmsDbg)
 *
 * @constructor
 * @extends Component
 * @param {Object} parmsDbg
 *
 * The Debugger component supports the following optional (parmsDbg) properties:
 *
 *      commands: string containing zero or more commands, separated by ';'
 *
 *      messages: string containing zero or more message categories to enable;
 *      multiple categories must be separated by '|' or ';'.  Parsed by messageInit().
 *
 * The Debugger component is an optional component that implements a variety of user
 * commands for controlling the CPU, dumping and editing memory, etc.
 */
function Debugger(parmsDbg)
{
    if (DEBUGGER) {

        Component.call(this, "Debugger", parmsDbg, Debugger);

        /*
         * These keep track of instruction activity, but only when tracing or when Debugger checks
         * have been enabled (eg, one or more breakpoints have been set).
         *
         * They are zeroed by the reset() notification handler.  cInstructions is advanced by
         * stepCPU() and checkInstruction() calls.  nCycles is updated by every stepCPU() or stop()
         * call and simply represents the number of cycles performed by the last run of instructions.
         */
        this.nCycles = -1;
        this.cOpcodes = -1;

        /*
         * Default number of hex chars in a register and a linear address (ie, for real-mode);
         * updated by initBus().
         */
        this.cchReg = 4;
        this.maskReg = 0xffff;
        this.cchAddr = 5;
        this.maskAddr = 0xfffff;

        /*
         * Most commands that require an address call parseAddr(), which defaults to dbgAddrNextCode
         * or dbgAddrNextData when no address has been given.  doDump() and doUnassemble(), in turn,
         * update dbgAddrNextData and dbgAddrNextCode, respectively, when they're done.
         *
         * All dbgAddr variables contain properties off, sel, and addr, where sel:off represents the
         * segmented address and addr is the corresponding linear address (if known).  For certain
         * segmented addresses (eg, breakpoint addresses), we pre-compute the linear address and save
         * that in addr, so that the breakpoint will still operate as intended even if the mode changes
         * later (eg, from real-mode to protected-mode).
         *
         * Finally, for TEMPORARY breakpoint addresses, we set fTempBreak to true, so that they can be
         * automatically cleared when they're hit.
         */
        this.dbgAddrNextCode = this.newAddr();
        this.dbgAddrNextData = this.newAddr();

        /*
         * This maintains command history.  New commands are inserted at index 0 of the array.
         * When Enter is pressed on an empty input buffer, we default to the command at aPrevCmds[0].
         */
        this.iPrevCmd = -1;
        this.aPrevCmds = [];

        /*
         * fAssemble is true when "assemble mode" is active, false when not.
         */
        this.fAssemble = false;
        this.dbgAddrAssemble = this.newAddr();

        /*
         * aSymbolTable is an array of 4-element arrays, one per ROM or other chunk of address space.
         * Each 4-element arrays contains:
         *
         *      [0]: addr
         *      [1]: size
         *      [2]: aSymbols
         *      [3]: aOffsetPairs
         *
         * See addSymbols() for more details, since that's how callers add sets of symbols to the table.
         */
        this.aSymbolTable = [];

        /*
         * aVariables is an object with properties that grows as setVariable() assigns more variables;
         * each property corresponds to one variable, where the property name is the variable name (ie,
         * a string beginning with a letter or underscore, followed by zero or more additional letters,
         * digits, or underscores) and the property value is the variable's numeric value.  See doLet()
         * and setVariable() for details.
         *
         * Note that parseValue(), through its reliance on str.parseInt(), assumes a default base of 16
         * if no base is explicitly indicated (eg, a trailing decimal period), and if you define variable
         * names containing exclusively hex alpha characters (a-f), those variables will take precedence
         * over the corresponding hex values.  In other words, if you define variables "a" and "b", you
         * will no longer be able to simply type "a" or "b" to specify the decimal values 10 or 11.
         */
        this.aVariables = {};

        /*
         * clearBreakpoints() initializes the breakpoints lists: aBreakExec is a list of addresses
         * to halt on whenever attempting to execute an instruction at the corresponding address,
         * and aBreakRead and aBreakWrite are lists of addresses to halt on whenever a read or write,
         * respectively, occurs at the corresponding address.
         *
         * NOTE: Curiously, after upgrading the Google Closure Compiler from v20141215 to v20150609,
         * the resulting compiled code would crash in clearBreakpoints(), because the (renamed) aBreakRead
         * property was already defined.  To eliminate whatever was confusing the Closure Compiler, I've
         * explicitly initialized all the properties that clearBreakpoints() (re)initializes.
         */
        this.aBreakExec = this.aBreakRead = this.aBreakWrite = [];
        this.clearBreakpoints();

        /*
         * Execution history is allocated by historyInit() whenever checksEnabled() conditions change.
         * Execution history is updated whenever the CPU calls checkInstruction(), which will happen
         * only when checksEnabled() returns true (eg, whenever one or more breakpoints have been set).
         * This ensures that, by default, the CPU runs as fast as possible.
         */
        this.historyInit();

        /*
         * Initialize Debugger message support
         */
        this.messageInit(parmsDbg['messages']);

        /*
         * The instruction trace buffer is a lightweight logging mechanism with minimal impact
         * on the browser (unlike printing to either console.log or an HTML control, which can
         * make the browser unusable if printing is too frequent).  The Debugger's info command
         * ("n dump [#]") dumps this buffer.  Note that dumping too much at once can also bog
         * things down, but by that point, you've presumably already captured the info you need
         * and are willing to wait.
         */
        if (DEBUG) this.traceInit();

        this.sInitCommands = parmsDbg['commands'];

        /*
         * Make it easier to access Debugger commands from an external REPL (eg, the WebStorm
         * "live" console window); eg:
         *
         *      $('r')
         *      $('dw 0:0')
         *      $('h')
         *      ...
         *
         * WARNING: doCommand() expects the same conditions that parseCommand() imposes; ie, a trim and
         * lower-case command string.
         */
        var dbg = this;
        if (window) {
            if (window['$'] === undefined) {
                window['$'] = function(s) { return dbg.doCommand(s); };
            }
        } else {
            if (global['$'] === undefined) {
                global['$'] = function(s) { return dbg.doCommand(s); };
            }
        }

    }   // endif DEBUGGER
}

if (DEBUGGER) {

    Component.subclass(Debugger);

    /*
     * Information regarding interrupts of interest (used by messageInt() and others)
     */
    Debugger.INT_MESSAGES = {
        0x10:       Messages.VIDEO,
        0x13:       Messages.FDC,
        0x15:       Messages.CHIPSET,
        0x16:       Messages.KEYBOARD,
     // 0x1A:       Messages.RTC,       // ChipSet contains its own custom messageInt() handler for the RTC
        0x1C:       Messages.TIMER,
        0x21:       Messages.DOS,
        0x33:       Messages.MOUSE
    };

    /*
     * Information regarding "annoying" interrupts (which aren't annoying so much as too frequent);
     * note that some of these can still be enabled if you really want them (eg, RTC can be turned on
     * with RTC messages, ALT_TIMER with TIMER messages, etc).
     */
    Debugger.INT_ANNOYING = [Interrupts.RTC, Interrupts.ALT_TIMER, Interrupts.DOS_IDLE, Interrupts.DOS_NETBIOS, Interrupts.ALT_VIDEO];

    Debugger.COMMANDS = {
        '?':     "help/print",
        'a [#]': "assemble",
        'b [#]': "breakpoint",          // multiple variations (use b? to list them)
        'c':     "clear output",
        'd [#]': "dump memory",         // additional syntax: d [#] [l#], where l# is a number of bytes to dump
        'e [#]': "edit memory",
        'f':     "frequencies",
        'g [#]': "go [to #]",
        'h':     "halt",
        'i [#]': "input port #",
        'k':     "stack trace",
        'l':     "load sector(s)",
        'm':     "messages",
        'o [#]': "output port #",
        'p':     "step over",           // other variations: pr (step and dump registers)
        'r':     "dump/set registers",
        't [#]': "trace",               // other variations: tr (trace and dump registers)
        'u [#]': "unassemble",
        'x':     "execution options",
        'if':    "eval expression",
        'let':   "assign expression",
        'mouse': "mouse action",        // syntax: mouse {action} {delta} (eg, mouse x 10, mouse click 0, etc)
        'print': "print expression",
        'reset': "reset machine",
        'ver':   "display version"
    };

    /*
     * Supported address types; the type field in a DbgAddr object may contain ONE of:
     *
     *      NONE, REAL, PROT, V86, LINEAR or PHYSICAL
     *
     * along with ONE of:
     *
     *      CODE or DATA
     *
     * REAL and V86 addresses are specifed with a '&' prefix, PROT addresses with a '#' prefix,
     * LINEAR addresses with '%', and PHYSICAL addresses with '%%'.
     */
    Debugger.ADDR = {
        NONE:       0x00,
        REAL:       0x01,
        PROT:       0x02,
        V86:        0x03,
        LINEAR:     0x04,
        PHYSICAL:   0x05,
        CODE:       0x10,
        DATA:       0x20
    };

    /*
     * Instruction ordinals
     */
    Debugger.INS = {
        NONE:   0,   AAA:    1,   AAD:    2,   AAM:    3,   AAS:    4,   ADC:    5,   ADD:    6,   AND:    7,
        ARPL:   8,   AS:     9,   BOUND:  10,  BSF:    11,  BSR:    12,  BT:     13,  BTC:    14,  BTR:    15,
        BTS:    16,  CALL:   17,  CBW:    18,  CLC:    19,  CLD:    20,  CLI:    21,  CLTS:   22,  CMC:    23,
        CMP:    24,  CMPSB:  25,  CMPSW:  26,  CS:     27,  CWD:    28,  DAA:    29,  DAS:    30,  DEC:    31,
        DIV:    32,  DS:     33,  ENTER:  34,  ES:     35,  ESC:    36,  FADD:   37,  FBLD:   38,  FBSTP:  39,
        FCOM:   40,  FCOMP:  41,  FDIV:   42,  FDIVR:  43,  FIADD:  44,  FICOM:  45,  FICOMP: 46,  FIDIV:  47,
        FIDIVR: 48,  FILD:   49,  FIMUL:  50,  FIST:   51,  FISTP:  52,  FISUB:  53,  FISUBR: 54,  FLD:    55,
        FLDCW:  56,  FLDENV: 57,  FMUL:   58,  FNSAVE: 59,  FNSTCW: 60,  FNSTENV:61,  FNSTSW: 62,  FRSTOR: 63,
        FS:     64,  FST:    65,  FSTP:   66,  FSUB:   67,  FSUBR:  68,  GS:     69,  HLT:    70,  IDIV:   71,
        IMUL:   72,  IN:     73,  INC:    74,  INS:    75,  INT:    76,  INT3:   77,  INTO:   78,  IRET:   79,
        JBE:    80,  JC:     81,  JCXZ:   82,  JG:     83,  JGE:    84,  JL:     85,  JLE:    86,  JMP:    87,
        JA:     88,  JNC:    89,  JNO:    90,  JNP:    91,  JNS:    92,  JNZ:    93,  JO:     94,  JP:     95,
        JS:     96,  JZ:     97,  LAHF:   98,  LAR:    99,  LDS:    100, LEA:    101, LEAVE:  102, LES:    103,
        LFS:    104, LGDT:   105, LGS:    106, LIDT:   107, LLDT:   108, LMSW:   109, LOADALL:110, LOCK:   111,
        LODSB:  112, LODSW:  113, LOOP:   114, LOOPNZ: 115, LOOPZ:  116, LSL:    117, LSS:    118, LTR:    119,
        MOV:    120, MOVSB:  121, MOVSW:  122, MOVSX:  123, MOVZX:  124, MUL:    125, NEG:    126, NOP:    127,
        NOT:    128, OR:     129, OS:     130, OUT:    131, OUTS:   132, POP:    133, POPA:   134, POPF:   135,
        PUSH:   136, PUSHA:  137, PUSHF:  138, RCL:    139, RCR:    140, REPNZ:  141, REPZ:   142, RET:    143,
        RETF:   144, ROL:    145, ROR:    146, SAHF:   147, SALC:   148, SAR:    149, SBB:    150, SCASB:  151,
        SCASW:  152, SETBE:  153, SETC:   154, SETG:   155, SETGE:  156, SETL:   157, SETLE:  158, SETNBE: 159,
        SETNC:  160, SETNO:  161, SETNP:  162, SETNS:  163, SETNZ:  164, SETO:   165, SETP:   166, SETS:   167,
        SETZ:   168, SGDT:   169, SHL:    170, SHLD:   171, SHR:    172, SHRD:   173, SIDT:   174, SLDT:   175,
        SMSW:   176, SS:     177, STC:    178, STD:    179, STI:    180, STOSB:  181, STOSW:  182, STR:    183,
        SUB:    184, TEST:   185, VERR:   186, VERW:   187, WAIT:   188, XCHG:   189, XLAT:   190, XOR:    191,
        GRP1B:  192, GRP1W:  193, GRP1SW: 194, GRP2B:  195, GRP2W:  196, GRP2B1: 197, GRP2W1: 198, GRP2BC: 199,
        GRP2WC: 200, GRP3B:  201, GRP3W:  202, GRP4B:  203, GRP4W:  204, OP0F:   205, GRP6:   206, GRP7:   207,
        GRP8:   208
    };

    /*
     * Instruction names (mnemonics), indexed by instruction ordinal (above)
     */
    Debugger.INS_NAMES = [
        "INVALID","AAA",    "AAD",    "AAM",    "AAS",    "ADC",    "ADD",    "AND",
        "ARPL",   "AS:",    "BOUND",  "BSF",    "BSR",    "BT",     "BTC",    "BTR",
        "BTS",    "CALL",   "CBW",    "CLC",    "CLD",    "CLI",    "CLTS",   "CMC",
        "CMP",    "CMPSB",  "CMPSW",  "CS:",    "CWD",    "DAA",    "DAS",    "DEC",
        "DIV",    "DS:",    "ENTER",  "ES:",    "ESC",    "FADD",   "FBLD",   "FBSTP",
        "FCOM",   "FCOMP",  "FDIV",   "FDIVR",  "FIADD",  "FICOM",  "FICOMP", "FIDIV",
        "FIDIVR", "FILD",   "FIMUL",  "FIST",   "FISTP",  "FISUB",  "FISUBR", "FLD",
        "FLDCW",  "FLDENV", "FMUL",   "FNSAVE", "FNSTCW", "FNSTENV","FNSTSW", "FRSTOR",
        "FS:",    "FST",    "FSTP",   "FSUB",   "FSUBR",  "GS:",    "HLT",    "IDIV",
        "IMUL",   "IN",     "INC",    "INS",    "INT",    "INT3",   "INTO",   "IRET",
        "JBE",    "JC",     "JCXZ",   "JG",     "JGE",    "JL",     "JLE",    "JMP",
        "JA",     "JNC",    "JNO",    "JNP",    "JNS",    "JNZ",    "JO",     "JP",
        "JS",     "JZ",     "LAHF",   "LAR",    "LDS",    "LEA",    "LEAVE",  "LES",
        "LFS",    "LGDT",   "LGS",    "LIDT",   "LLDT",   "LMSW",   "LOADALL","LOCK",
        "LODSB",  "LODSW",  "LOOP",   "LOOPNZ", "LOOPZ",  "LSL",    "LSS",    "LTR",
        "MOV",    "MOVSB",  "MOVSW",  "MOVSX",  "MOVZX",  "MUL",    "NEG",    "NOP",
        "NOT",    "OR",     "OS:",    "OUT",    "OUTS",   "POP",    "POPA",   "POPF",
        "PUSH",   "PUSHA",  "PUSHF",  "RCL",    "RCR",    "REPNZ",  "REPZ",   "RET",
        "RETF",   "ROL",    "ROR",    "SAHF",   "SALC",   "SAR",    "SBB",    "SCASB",
        "SCASW",  "SETBE",  "SETC",   "SETG",   "SETGE",  "SETL",   "SETLE",  "SETNBE",
        "SETNC",  "SETNO",  "SETNP",  "SETNS",  "SETNZ",  "SETO",   "SETP",   "SETS",
        "SETZ",   "SGDT",   "SHL",    "SHLD",   "SHR",    "SHRD",   "SIDT",   "SLDT",
        "SMSW",   "SS:",    "STC",    "STD",    "STI",    "STOSB",  "STOSW",  "STR",
        "SUB",    "TEST",   "VERR",   "VERW",   "WAIT",   "XCHG",   "XLAT",   "XOR"
    ];

    Debugger.CPU_8086  = 0;
    Debugger.CPU_80186 = 1;
    Debugger.CPU_80286 = 2;
    Debugger.CPU_80386 = 3;
    Debugger.CPUS = [8086, 80186, 80286, 80386];

    /*
     * ModRM masks and definitions
     */
    Debugger.REG_AL  = 0x00;             // bits 0-2 are standard Reg encodings
    Debugger.REG_CL  = 0x01;
    Debugger.REG_DL  = 0x02;
    Debugger.REG_BL  = 0x03;
    Debugger.REG_AH  = 0x04;
    Debugger.REG_CH  = 0x05;
    Debugger.REG_DH  = 0x06;
    Debugger.REG_BH  = 0x07;
    Debugger.REG_AX  = 0x08;
    Debugger.REG_CX  = 0x09;
    Debugger.REG_DX  = 0x0A;
    Debugger.REG_BX  = 0x0B;
    Debugger.REG_SP  = 0x0C;
    Debugger.REG_BP  = 0x0D;
    Debugger.REG_SI  = 0x0E;
    Debugger.REG_DI  = 0x0F;
    Debugger.REG_SEG = 0x10;
    Debugger.REG_IP  = 0x16;
    Debugger.REG_PS  = 0x17;
    Debugger.REG_EAX = 0x18;
    Debugger.REG_ECX = 0x19;
    Debugger.REG_EDX = 0x1A;
    Debugger.REG_EBX = 0x1B;
    Debugger.REG_ESP = 0x1C;
    Debugger.REG_EBP = 0x1D;
    Debugger.REG_ESI = 0x1E;
    Debugger.REG_EDI = 0x1F;
    Debugger.REG_CR0 = 0x20;
    Debugger.REG_CR1 = 0x21;
    Debugger.REG_CR2 = 0x22;
    Debugger.REG_CR3 = 0x23;
    Debugger.REG_DR0 = 0x28;
    Debugger.REG_DR1 = 0x29;
    Debugger.REG_DR2 = 0x2A;
    Debugger.REG_DR3 = 0x2B;
    Debugger.REG_DR6 = 0x2E;
    Debugger.REG_DR7 = 0x2F;
    Debugger.REG_TR0 = 0x30;
    Debugger.REG_TR6 = 0x36;
    Debugger.REG_TR7 = 0x37;
    Debugger.REG_EIP = 0x38;

    Debugger.REGS = [
        "AL",  "CL",  "DL",  "BL",  "AH",  "CH",  "DH",  "BH",
        "AX",  "CX",  "DX",  "BX",  "SP",  "BP",  "SI",  "DI",
        "ES",  "CS",  "SS",  "DS",  "FS",  "GS",  "IP",  "PS",
        "EAX", "ECX", "EDX", "EBX", "ESP", "EBP", "ESI", "EDI",
        "CR0", "CR1", "CR2", "CR3", null,  null,  null,  null,  // register names used with TYPE_CTLREG
        "DR0", "DR1", "DR2", "DR3", null,  null,  "DR6", "DR7", // register names used with TYPE_DBGREG
        null,  null,  null,  null,  null,  null,  "TR6", "TR7", // register names used with TYPE_TSTREG
        "EIP"
    ];

    Debugger.REG_ES         = 0x00;     // bits 0-1 are standard SegReg encodings
    Debugger.REG_CS         = 0x01;
    Debugger.REG_SS         = 0x02;
    Debugger.REG_DS         = 0x03;
    Debugger.REG_FS         = 0x04;
    Debugger.REG_GS         = 0x05;
    Debugger.REG_UNKNOWN    = 0x00;

    Debugger.MOD_NODISP     = 0x00;     // use RM below, no displacement
    Debugger.MOD_DISP8      = 0x01;     // use RM below + 8-bit displacement
    Debugger.MOD_DISP16     = 0x02;     // use RM below + 16-bit displacement
    Debugger.MOD_REGISTER   = 0x03;     // use REG above

    Debugger.RM_BXSI        = 0x00;
    Debugger.RM_BXDI        = 0x01;
    Debugger.RM_BPSI        = 0x02;
    Debugger.RM_BPDI        = 0x03;
    Debugger.RM_SI          = 0x04;
    Debugger.RM_DI          = 0x05;
    Debugger.RM_BP          = 0x06;
    Debugger.RM_IMMOFF      = Debugger.RM_BP;       // only if MOD_NODISP
    Debugger.RM_BX          = 0x07;

    Debugger.RMS = [
        "BX+SI", "BX+DI", "BP+SI", "BP+DI", "SI",    "DI",    "BP",    "BX",
        "EAX",   "ECX",   "EDX",   "EBX",   "ESP",   "EBP",   "ESI",   "EDI"
    ];

    /*
     * Operand type descriptor masks and definitions
     *
     * Note that the letters in () in the comments refer to Intel's
     * nomenclature used in Appendix A of the 80386 Programmers Reference Manual.
     */
    Debugger.TYPE_SIZE      = 0x000F;   // size field
    Debugger.TYPE_MODE      = 0x00F0;   // mode field
    Debugger.TYPE_IREG      = 0x0F00;   // implied register field
    Debugger.TYPE_OTHER     = 0xF000;   // "other" field

    /*
     * TYPE_SIZE values.  Some of the values (eg, TYPE_WORDIB and TYPE_WORDIW)
     * imply the presence of a third operand, for those weird cases....
     */
    Debugger.TYPE_NONE      = 0x0000;   //     (all other TYPE fields ignored)
    Debugger.TYPE_BYTE      = 0x0001;   // (b) byte, regardless of operand size
    Debugger.TYPE_SBYTE     = 0x0002;   //     byte sign-extended to word
    Debugger.TYPE_WORD      = 0x0003;   // (w) word, regardless...
    Debugger.TYPE_VWORD     = 0x0004;   // (v) word or double-word, depending...
    Debugger.TYPE_DWORD     = 0x0005;   // (d) double-word, regardless...
    Debugger.TYPE_SEGP      = 0x0006;   // (p) 32-bit or 48-bit pointer
    Debugger.TYPE_FARP      = 0x0007;   // (p) 32-bit or 48-bit pointer for JMP/CALL
    Debugger.TYPE_2WORD     = 0x0008;   // (a) two memory operands (BOUND only)
    Debugger.TYPE_DESC      = 0x0009;   // (s) 6 byte pseudo-descriptor
    Debugger.TYPE_WORDIB    = 0x000A;   //     two source operands (eg, IMUL)
    Debugger.TYPE_WORDIW    = 0x000B;   //     two source operands (eg, IMUL)
    Debugger.TYPE_PREFIX    = 0x000F;   //     (treat similarly to TYPE_NONE)

    /*
     * TYPE_MODE values.  Order is somewhat important, as all values implying
     * the presence of a ModRM byte are assumed to be >= TYPE_MODRM.
     */
    Debugger.TYPE_IMM       = 0x0000;   // (I) immediate data
    Debugger.TYPE_ONE       = 0x0010;   //     implicit 1 (eg, shifts/rotates)
    Debugger.TYPE_IMMOFF    = 0x0020;   // (A) immediate offset
    Debugger.TYPE_IMMREL    = 0x0030;   // (J) immediate relative
    Debugger.TYPE_DSSI      = 0x0040;   // (X) memory addressed by DS:SI
    Debugger.TYPE_ESDI      = 0x0050;   // (Y) memory addressed by ES:DI
    Debugger.TYPE_IMPREG    = 0x0060;   //     implicit register in TYPE_IREG
    Debugger.TYPE_IMPSEG    = 0x0070;   //     implicit segment register in TYPE_IREG
    Debugger.TYPE_MODRM     = 0x0080;   // (E) standard ModRM decoding
    Debugger.TYPE_MODMEM    = 0x0090;   // (M) ModRM refers to memory only
    Debugger.TYPE_MODREG    = 0x00A0;   // (R) ModRM refers to register only
    Debugger.TYPE_REG       = 0x00B0;   // (G) standard Reg decoding
    Debugger.TYPE_SEGREG    = 0x00C0;   // (S) Reg selects segment register
    Debugger.TYPE_CTLREG    = 0x00D0;   // (C) Reg selects control register
    Debugger.TYPE_DBGREG    = 0x00E0;   // (D) Reg selects debug register
    Debugger.TYPE_TSTREG    = 0x00F0;   // (T) Reg selects test register

    /*
     * TYPE_IREG values, based on the REG_* constants.
     * For convenience, they include TYPE_IMPREG or TYPE_IMPSEG as appropriate.
     */
    Debugger.TYPE_AL = (Debugger.REG_AL << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_BYTE);
    Debugger.TYPE_CL = (Debugger.REG_CL << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_BYTE);
    Debugger.TYPE_DL = (Debugger.REG_DL << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_BYTE);
    Debugger.TYPE_BL = (Debugger.REG_BL << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_BYTE);
    Debugger.TYPE_AH = (Debugger.REG_AH << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_BYTE);
    Debugger.TYPE_CH = (Debugger.REG_CH << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_BYTE);
    Debugger.TYPE_DH = (Debugger.REG_DH << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_BYTE);
    Debugger.TYPE_BH = (Debugger.REG_BH << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_BYTE);
    Debugger.TYPE_AX = (Debugger.REG_AX << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_VWORD);
    Debugger.TYPE_CX = (Debugger.REG_CX << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_VWORD);
    Debugger.TYPE_DX = (Debugger.REG_DX << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_VWORD);
    Debugger.TYPE_BX = (Debugger.REG_BX << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_VWORD);
    Debugger.TYPE_SP = (Debugger.REG_SP << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_VWORD);
    Debugger.TYPE_BP = (Debugger.REG_BP << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_VWORD);
    Debugger.TYPE_SI = (Debugger.REG_SI << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_VWORD);
    Debugger.TYPE_DI = (Debugger.REG_DI << 8 | Debugger.TYPE_IMPREG | Debugger.TYPE_VWORD);
    Debugger.TYPE_ES = (Debugger.REG_ES << 8 | Debugger.TYPE_IMPSEG | Debugger.TYPE_WORD);
    Debugger.TYPE_CS = (Debugger.REG_CS << 8 | Debugger.TYPE_IMPSEG | Debugger.TYPE_WORD);
    Debugger.TYPE_SS = (Debugger.REG_SS << 8 | Debugger.TYPE_IMPSEG | Debugger.TYPE_WORD);
    Debugger.TYPE_DS = (Debugger.REG_DS << 8 | Debugger.TYPE_IMPSEG | Debugger.TYPE_WORD);
    Debugger.TYPE_FS = (Debugger.REG_FS << 8 | Debugger.TYPE_IMPSEG | Debugger.TYPE_WORD);
    Debugger.TYPE_GS = (Debugger.REG_GS << 8 | Debugger.TYPE_IMPSEG | Debugger.TYPE_WORD);

    /*
     * TYPE_OTHER bit definitions
     */
    Debugger.TYPE_IN    = 0x1000;        // operand is input
    Debugger.TYPE_OUT   = 0x2000;        // operand is output
    Debugger.TYPE_BOTH  = (Debugger.TYPE_IN | Debugger.TYPE_OUT);
    Debugger.TYPE_8086  = (Debugger.CPU_8086 << 14);
    Debugger.TYPE_80186 = (Debugger.CPU_80186 << 14);
    Debugger.TYPE_80286 = (Debugger.CPU_80286 << 14);
    Debugger.TYPE_80386 = (Debugger.CPU_80386 << 14);
    Debugger.TYPE_CPU_SHIFT = 14;

    /*
     * Message categories supported by the messageEnabled() function and other assorted message
     * functions. Each category has a corresponding bit value that can be combined (ie, OR'ed) as
     * needed.  The Debugger's message command ("m") is used to turn message categories on and off,
     * like so:
     *
     *      m port on
     *      m port off
     *      ...
     *
     * NOTE: The order of these categories can be rearranged, alphabetized, etc, as desired; just be
     * aware that changing the bit values could break saved Debugger states (not a huge concern, just
     * something to be aware of).
     */
    Debugger.MESSAGES = {
        "cpu":      Messages.CPU,
        "seg":      Messages.SEG,
        "desc":     Messages.DESC,
        "tss":      Messages.TSS,
        "int":      Messages.INT,
        "fault":    Messages.FAULT,
        "bus":      Messages.BUS,
        "mem":      Messages.MEM,
        "port":     Messages.PORT,
        "dma":      Messages.DMA,
        "pic":      Messages.PIC,
        "timer":    Messages.TIMER,
        "cmos":     Messages.CMOS,
        "rtc":      Messages.RTC,
        "8042":     Messages.C8042,
        "chipset":  Messages.CHIPSET,   // ie, anything else in ChipSet besides DMA, PIC, TIMER, CMOS, RTC and 8042
        "keyboard": Messages.KEYBOARD,  // "kbd" is also allowed as shorthand for "keyboard"; see doMessages()
        "key":      Messages.KEYS,      // using "key" instead of "keys", since the latter is a method on JavasScript objects
        "video":    Messages.VIDEO,
        "fdc":      Messages.FDC,
        "hdc":      Messages.HDC,
        "disk":     Messages.DISK,
        "serial":   Messages.SERIAL,
        "speaker":  Messages.SPEAKER,
        "state":    Messages.STATE,
        "mouse":    Messages.MOUSE,
        "computer": Messages.COMPUTER,
        "dos":      Messages.DOS,
        "data":     Messages.DATA,
        "log":      Messages.LOG,
        "warn":     Messages.WARN,
        /*
         * Now we turn to message actions rather than message types; for example, setting "halt"
         * on or off doesn't enable "halt" messages, but rather halts the CPU on any message above.
         */
        "halt":     Messages.HALT
    };

    /*
     * Instruction trace categories supported by the traceLog() function.  The Debugger's info
     * command ("n") is used to turn trace categories on and off, like so:
     *
     *      n shl on
     *      n shl off
     *      ...
     *
     * Note that there are usually multiple entries for each category (one for each supported operand size);
     * all matching entries are enabled or disabled as a group.
     */
    Debugger.TRACE = {
        ROLB:   {ins: Debugger.INS.ROL,  size: 8},
        ROLW:   {ins: Debugger.INS.ROL,  size: 16},
        RORB:   {ins: Debugger.INS.ROR,  size: 8},
        RORW:   {ins: Debugger.INS.ROR,  size: 16},
        RCLB:   {ins: Debugger.INS.RCL,  size: 8},
        RCLW:   {ins: Debugger.INS.RCL,  size: 16},
        RCRB:   {ins: Debugger.INS.RCR,  size: 8},
        RCRW:   {ins: Debugger.INS.RCR,  size: 16},
        SHLB:   {ins: Debugger.INS.SHL,  size: 8},
        SHLW:   {ins: Debugger.INS.SHL,  size: 16},
        MULB:   {ins: Debugger.INS.MUL,  size: 16}, // dst is 8-bit (AL), src is 8-bit (operand), result is 16-bit (AH:AL)
        IMULB:  {ins: Debugger.INS.IMUL, size: 16}, // dst is 8-bit (AL), src is 8-bit (operand), result is 16-bit (AH:AL)
        DIVB:   {ins: Debugger.INS.DIV,  size: 16}, // dst is 16-bit (AX), src is 8-bit (operand), result is 16-bit (AH:AL, remainder:quotient)
        IDIVB:  {ins: Debugger.INS.IDIV, size: 16}, // dst is 16-bit (AX), src is 8-bit (operand), result is 16-bit (AH:AL, remainder:quotient)
        MULW:   {ins: Debugger.INS.MUL,  size: 32}, // dst is 16-bit (AX), src is 16-bit (operand), result is 32-bit (DX:AX)
        IMULW:  {ins: Debugger.INS.IMUL, size: 32}, // dst is 16-bit (AX), src is 16-bit (operand), result is 32-bit (DX:AX)
        DIVW:   {ins: Debugger.INS.DIV,  size: 32}, // dst is 32-bit (DX:AX), src is 16-bit (operand), result is 32-bit (DX:AX, remainder:quotient)
        IDIVW:  {ins: Debugger.INS.IDIV, size: 32}  // dst is 32-bit (DX:AX), src is 16-bit (operand), result is 32-bit (DX:AX, remainder:quotient)
    };

    Debugger.TRACE_LIMIT = 100000;
    Debugger.HISTORY_LIMIT = DEBUG? 100000 : 1000;

    /*
     * Opcode 0x0F has a distinguished history:
     *
     *      On the 8086, it functioned as POP CS
     *      On the 80186, it generated an Invalid Opcode (UD_FAULT) exception
     *      On the 80286, it introduced a new (and growing) series of two-byte opcodes
     *
     * Based on the active CPU model, we make every effort to execute and disassemble this (and every other)
     * opcode appropriately, by setting the opcode's entry in aaOpDescs accordingly.  0x0F in aaOpDescs points
     * to the 8086 table: aOpDescPopCS.
     *
     * Note that we must NOT modify aaOpDescs directly.  this.aaOpDescs will point to Debugger.aaOpDescs
     * if the processor is an 8086, because that's the processor that the hard-coded contents of the table
     * represent; for all other processors, this.aaOpDescs will contain a copy of the table that we can modify.
     */
    Debugger.aOpDescPopCS     = [Debugger.INS.POP,  Debugger.TYPE_CS   | Debugger.TYPE_OUT];
    Debugger.aOpDescUndefined = [Debugger.INS.NONE, Debugger.TYPE_NONE];
    Debugger.aOpDesc0F        = [Debugger.INS.OP0F, Debugger.TYPE_WORD | Debugger.TYPE_BOTH];

    /*
     * The aaOpDescs array is indexed by opcode, and each element is a sub-array (aOpDesc) that describes
     * the corresponding opcode. The sub-elements are as follows:
     *
     *      [0]: {number} of the opcode name (see INS.*)
     *      [1]: {number} containing the destination operand descriptor bit(s), if any
     *      [2]: {number} containing the source operand descriptor bit(s), if any
     *      [3]: {number} containing the occasional third operand descriptor bit(s), if any
     *
     * These sub-elements are all optional. If [0] is not present, the opcode is undefined; if [1] is not
     * present (or contains zero), the opcode has no (or only implied) operands; if [2] is not present, the
     * opcode has only a single operand.  And so on.
     */
    Debugger.aaOpDescs = [
    /* 0x00 */ [Debugger.INS.ADD,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x01 */ [Debugger.INS.ADD,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x02 */ [Debugger.INS.ADD,   Debugger.TYPE_REG    | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x03 */ [Debugger.INS.ADD,   Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x04 */ [Debugger.INS.ADD,   Debugger.TYPE_AL     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x05 */ [Debugger.INS.ADD,   Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x06 */ [Debugger.INS.PUSH,  Debugger.TYPE_ES     | Debugger.TYPE_IN],
    /* 0x07 */ [Debugger.INS.POP,   Debugger.TYPE_ES     | Debugger.TYPE_OUT],

    /* 0x08 */ [Debugger.INS.OR,    Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x09 */ [Debugger.INS.OR,    Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x0A */ [Debugger.INS.OR,    Debugger.TYPE_REG    | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x0B */ [Debugger.INS.OR,    Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x0C */ [Debugger.INS.OR,    Debugger.TYPE_AL     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x0D */ [Debugger.INS.OR,    Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x0E */ [Debugger.INS.PUSH,  Debugger.TYPE_CS     | Debugger.TYPE_IN],
    /* 0x0F */ Debugger.aOpDescPopCS,

    /* 0x10 */ [Debugger.INS.ADC,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x11 */ [Debugger.INS.ADC,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x12 */ [Debugger.INS.ADC,   Debugger.TYPE_REG    | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x13 */ [Debugger.INS.ADC,   Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x14 */ [Debugger.INS.ADC,   Debugger.TYPE_AL     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x15 */ [Debugger.INS.ADC,   Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x16 */ [Debugger.INS.PUSH,  Debugger.TYPE_SS     | Debugger.TYPE_IN],
    /* 0x17 */ [Debugger.INS.POP,   Debugger.TYPE_SS     | Debugger.TYPE_OUT],

    /* 0x18 */ [Debugger.INS.SBB,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x19 */ [Debugger.INS.SBB,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x1A */ [Debugger.INS.SBB,   Debugger.TYPE_REG    | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x1B */ [Debugger.INS.SBB,   Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x1C */ [Debugger.INS.SBB,   Debugger.TYPE_AL     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x1D */ [Debugger.INS.SBB,   Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x1E */ [Debugger.INS.PUSH,  Debugger.TYPE_DS     | Debugger.TYPE_IN],
    /* 0x1F */ [Debugger.INS.POP,   Debugger.TYPE_DS     | Debugger.TYPE_OUT],

    /* 0x20 */ [Debugger.INS.AND,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x21 */ [Debugger.INS.AND,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x22 */ [Debugger.INS.AND,   Debugger.TYPE_REG    | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x23 */ [Debugger.INS.AND,   Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x24 */ [Debugger.INS.AND,   Debugger.TYPE_AL     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x25 */ [Debugger.INS.AND,   Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x26 */ [Debugger.INS.ES,    Debugger.TYPE_PREFIX],
    /* 0x27 */ [Debugger.INS.DAA],

    /* 0x28 */ [Debugger.INS.SUB,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x29 */ [Debugger.INS.SUB,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x2A */ [Debugger.INS.SUB,   Debugger.TYPE_REG    | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x2B */ [Debugger.INS.SUB,   Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x2C */ [Debugger.INS.SUB,   Debugger.TYPE_AL     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x2D */ [Debugger.INS.SUB,   Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x2E */ [Debugger.INS.CS,    Debugger.TYPE_PREFIX],
    /* 0x2F */ [Debugger.INS.DAS],

    /* 0x30 */ [Debugger.INS.XOR,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x31 */ [Debugger.INS.XOR,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_REG   | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x32 */ [Debugger.INS.XOR,   Debugger.TYPE_REG    | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x33 */ [Debugger.INS.XOR,   Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x34 */ [Debugger.INS.XOR,   Debugger.TYPE_AL     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x35 */ [Debugger.INS.XOR,   Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x36 */ [Debugger.INS.SS,    Debugger.TYPE_PREFIX],
    /* 0x37 */ [Debugger.INS.AAA],

    /* 0x38 */ [Debugger.INS.CMP,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_IN,   Debugger.TYPE_REG   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x39 */ [Debugger.INS.CMP,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN,   Debugger.TYPE_REG   | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x3A */ [Debugger.INS.CMP,   Debugger.TYPE_REG    | Debugger.TYPE_BYTE  | Debugger.TYPE_IN,   Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x3B */ [Debugger.INS.CMP,   Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN,   Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x3C */ [Debugger.INS.CMP,   Debugger.TYPE_AL     | Debugger.TYPE_IN,     Debugger.TYPE_IMM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x3D */ [Debugger.INS.CMP,   Debugger.TYPE_AX     | Debugger.TYPE_IN,     Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x3E */ [Debugger.INS.DS,    Debugger.TYPE_PREFIX],
    /* 0x3F */ [Debugger.INS.AAS],

    /* 0x40 */ [Debugger.INS.INC,   Debugger.TYPE_AX     | Debugger.TYPE_BOTH],
    /* 0x41 */ [Debugger.INS.INC,   Debugger.TYPE_CX     | Debugger.TYPE_BOTH],
    /* 0x42 */ [Debugger.INS.INC,   Debugger.TYPE_DX     | Debugger.TYPE_BOTH],
    /* 0x43 */ [Debugger.INS.INC,   Debugger.TYPE_BX     | Debugger.TYPE_BOTH],
    /* 0x44 */ [Debugger.INS.INC,   Debugger.TYPE_SP     | Debugger.TYPE_BOTH],
    /* 0x45 */ [Debugger.INS.INC,   Debugger.TYPE_BP     | Debugger.TYPE_BOTH],
    /* 0x46 */ [Debugger.INS.INC,   Debugger.TYPE_SI     | Debugger.TYPE_BOTH],
    /* 0x47 */ [Debugger.INS.INC,   Debugger.TYPE_DI     | Debugger.TYPE_BOTH],

    /* 0x48 */ [Debugger.INS.DEC,   Debugger.TYPE_AX     | Debugger.TYPE_BOTH],
    /* 0x49 */ [Debugger.INS.DEC,   Debugger.TYPE_CX     | Debugger.TYPE_BOTH],
    /* 0x4A */ [Debugger.INS.DEC,   Debugger.TYPE_DX     | Debugger.TYPE_BOTH],
    /* 0x4B */ [Debugger.INS.DEC,   Debugger.TYPE_BX     | Debugger.TYPE_BOTH],
    /* 0x4C */ [Debugger.INS.DEC,   Debugger.TYPE_SP     | Debugger.TYPE_BOTH],
    /* 0x4D */ [Debugger.INS.DEC,   Debugger.TYPE_BP     | Debugger.TYPE_BOTH],
    /* 0x4E */ [Debugger.INS.DEC,   Debugger.TYPE_SI     | Debugger.TYPE_BOTH],
    /* 0x4F */ [Debugger.INS.DEC,   Debugger.TYPE_DI     | Debugger.TYPE_BOTH],

    /* 0x50 */ [Debugger.INS.PUSH,  Debugger.TYPE_AX     | Debugger.TYPE_IN],
    /* 0x51 */ [Debugger.INS.PUSH,  Debugger.TYPE_CX     | Debugger.TYPE_IN],
    /* 0x52 */ [Debugger.INS.PUSH,  Debugger.TYPE_DX     | Debugger.TYPE_IN],
    /* 0x53 */ [Debugger.INS.PUSH,  Debugger.TYPE_BX     | Debugger.TYPE_IN],
    /* 0x54 */ [Debugger.INS.PUSH,  Debugger.TYPE_SP     | Debugger.TYPE_IN],
    /* 0x55 */ [Debugger.INS.PUSH,  Debugger.TYPE_BP     | Debugger.TYPE_IN],
    /* 0x56 */ [Debugger.INS.PUSH,  Debugger.TYPE_SI     | Debugger.TYPE_IN],
    /* 0x57 */ [Debugger.INS.PUSH,  Debugger.TYPE_DI     | Debugger.TYPE_IN],

    /* 0x58 */ [Debugger.INS.POP,   Debugger.TYPE_AX     | Debugger.TYPE_OUT],
    /* 0x59 */ [Debugger.INS.POP,   Debugger.TYPE_CX     | Debugger.TYPE_OUT],
    /* 0x5A */ [Debugger.INS.POP,   Debugger.TYPE_DX     | Debugger.TYPE_OUT],
    /* 0x5B */ [Debugger.INS.POP,   Debugger.TYPE_BX     | Debugger.TYPE_OUT],
    /* 0x5C */ [Debugger.INS.POP,   Debugger.TYPE_SP     | Debugger.TYPE_OUT],
    /* 0x5D */ [Debugger.INS.POP,   Debugger.TYPE_BP     | Debugger.TYPE_OUT],
    /* 0x5E */ [Debugger.INS.POP,   Debugger.TYPE_SI     | Debugger.TYPE_OUT],
    /* 0x5F */ [Debugger.INS.POP,   Debugger.TYPE_DI     | Debugger.TYPE_OUT],

    /* 0x60 */ [Debugger.INS.PUSHA, Debugger.TYPE_NONE   | Debugger.TYPE_80286],
    /* 0x61 */ [Debugger.INS.POPA,  Debugger.TYPE_NONE   | Debugger.TYPE_80286],
    /* 0x62 */ [Debugger.INS.BOUND, Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80286, Debugger.TYPE_MODRM | Debugger.TYPE_2WORD | Debugger.TYPE_IN],
    /* 0x63 */ [Debugger.INS.ARPL,  Debugger.TYPE_MODRM  | Debugger.TYPE_WORD  | Debugger.TYPE_OUT,                        Debugger.TYPE_REG   | Debugger.TYPE_WORD  | Debugger.TYPE_IN],
    /* 0x64 */ [Debugger.INS.FS,    Debugger.TYPE_PREFIX | Debugger.TYPE_80386],
    /* 0x65 */ [Debugger.INS.GS,    Debugger.TYPE_PREFIX | Debugger.TYPE_80386],
    /* 0x66 */ [Debugger.INS.OS,    Debugger.TYPE_PREFIX | Debugger.TYPE_80386],
    /* 0x67 */ [Debugger.INS.AS,    Debugger.TYPE_PREFIX | Debugger.TYPE_80386],

    /* 0x68 */ [Debugger.INS.PUSH,  Debugger.TYPE_IMM    | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80286],
    /* 0x69 */ [Debugger.INS.IMUL,  Debugger.TYPE_REG    | Debugger.TYPE_WORD  | Debugger.TYPE_BOTH | Debugger.TYPE_80286,   Debugger.TYPE_MODRM | Debugger.TYPE_WORDIW | Debugger.TYPE_IN],
    /* 0x6A */ [Debugger.INS.PUSH,  Debugger.TYPE_IMM    | Debugger.TYPE_SBYTE | Debugger.TYPE_IN   | Debugger.TYPE_80286],
    /* 0x6B */ [Debugger.INS.IMUL,  Debugger.TYPE_REG    | Debugger.TYPE_WORD  | Debugger.TYPE_BOTH | Debugger.TYPE_80286,   Debugger.TYPE_MODRM | Debugger.TYPE_WORDIB | Debugger.TYPE_IN],
    /* 0x6C */ [Debugger.INS.INS,   Debugger.TYPE_ESDI   | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80286,   Debugger.TYPE_DX    | Debugger.TYPE_IN],
    /* 0x6D */ [Debugger.INS.INS,   Debugger.TYPE_ESDI   | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80286,   Debugger.TYPE_DX    | Debugger.TYPE_IN],
    /* 0x6E */ [Debugger.INS.OUTS,  Debugger.TYPE_DX     | Debugger.TYPE_IN    | Debugger.TYPE_80286,   Debugger.TYPE_DSSI | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x6F */ [Debugger.INS.OUTS,  Debugger.TYPE_DX     | Debugger.TYPE_IN    | Debugger.TYPE_80286,   Debugger.TYPE_DSSI | Debugger.TYPE_VWORD | Debugger.TYPE_IN],

    /* 0x70 */ [Debugger.INS.JO,    Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x71 */ [Debugger.INS.JNO,   Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x72 */ [Debugger.INS.JC,    Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x73 */ [Debugger.INS.JNC,   Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x74 */ [Debugger.INS.JZ,    Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x75 */ [Debugger.INS.JNZ,   Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x76 */ [Debugger.INS.JBE,   Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x77 */ [Debugger.INS.JA,    Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],

    /* 0x78 */ [Debugger.INS.JS,    Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x79 */ [Debugger.INS.JNS,   Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x7A */ [Debugger.INS.JP,    Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x7B */ [Debugger.INS.JNP,   Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x7C */ [Debugger.INS.JL,    Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x7D */ [Debugger.INS.JGE,   Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x7E */ [Debugger.INS.JLE,   Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x7F */ [Debugger.INS.JG,    Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],

    /* 0x80 */ [Debugger.INS.GRP1B, Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_IMM   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x81 */ [Debugger.INS.GRP1W, Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM   | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x82 */ [Debugger.INS.GRP1B, Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_IMM   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x83 */ [Debugger.INS.GRP1SW,Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x84 */ [Debugger.INS.TEST,  Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_IN,   Debugger.TYPE_REG   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x85 */ [Debugger.INS.TEST,  Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN,   Debugger.TYPE_REG   | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x86 */ [Debugger.INS.XCHG,  Debugger.TYPE_REG    | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH],
    /* 0x87 */ [Debugger.INS.XCHG,  Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH],

    /* 0x88 */ [Debugger.INS.MOV,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT,  Debugger.TYPE_REG    | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x89 */ [Debugger.INS.MOV,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_OUT,  Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x8A */ [Debugger.INS.MOV,   Debugger.TYPE_REG    | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT,  Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0x8B */ [Debugger.INS.MOV,   Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_OUT,  Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x8C */ [Debugger.INS.MOV,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_OUT,  Debugger.TYPE_SEGREG | Debugger.TYPE_WORD  | Debugger.TYPE_IN],
    /* 0x8D */ [Debugger.INS.LEA,   Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_OUT,  Debugger.TYPE_MODMEM | Debugger.TYPE_VWORD],
    /* 0x8E */ [Debugger.INS.MOV,   Debugger.TYPE_SEGREG | Debugger.TYPE_WORD  | Debugger.TYPE_OUT,  Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0x8F */ [Debugger.INS.POP,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_OUT],

    /* 0x90 */ [Debugger.INS.NOP],
    /* 0x91 */ [Debugger.INS.XCHG,  Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_CX | Debugger.TYPE_BOTH],
    /* 0x92 */ [Debugger.INS.XCHG,  Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_DX | Debugger.TYPE_BOTH],
    /* 0x93 */ [Debugger.INS.XCHG,  Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_BX | Debugger.TYPE_BOTH],
    /* 0x94 */ [Debugger.INS.XCHG,  Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_SP | Debugger.TYPE_BOTH],
    /* 0x95 */ [Debugger.INS.XCHG,  Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_BP | Debugger.TYPE_BOTH],
    /* 0x96 */ [Debugger.INS.XCHG,  Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_SI | Debugger.TYPE_BOTH],
    /* 0x97 */ [Debugger.INS.XCHG,  Debugger.TYPE_AX     | Debugger.TYPE_BOTH,   Debugger.TYPE_DI | Debugger.TYPE_BOTH],

    /* 0x98 */ [Debugger.INS.CBW],
    /* 0x99 */ [Debugger.INS.CWD],
    /* 0x9A */ [Debugger.INS.CALL,  Debugger.TYPE_IMM    | Debugger.TYPE_FARP |  Debugger.TYPE_IN],
    /* 0x9B */ [Debugger.INS.WAIT],
    /* 0x9C */ [Debugger.INS.PUSHF],
    /* 0x9D */ [Debugger.INS.POPF],
    /* 0x9E */ [Debugger.INS.SAHF],
    /* 0x9F */ [Debugger.INS.LAHF],

    /* 0xA0 */ [Debugger.INS.MOV,   Debugger.TYPE_AL     | Debugger.TYPE_OUT,    Debugger.TYPE_IMMOFF | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xA1 */ [Debugger.INS.MOV,   Debugger.TYPE_AX     | Debugger.TYPE_OUT,    Debugger.TYPE_IMMOFF | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xA2 */ [Debugger.INS.MOV,   Debugger.TYPE_IMMOFF | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT,     Debugger.TYPE_AL    | Debugger.TYPE_IN],
    /* 0xA3 */ [Debugger.INS.MOV,   Debugger.TYPE_IMMOFF | Debugger.TYPE_VWORD | Debugger.TYPE_OUT,     Debugger.TYPE_AX    | Debugger.TYPE_IN],
    /* 0xA4 */ [Debugger.INS.MOVSB, Debugger.TYPE_ESDI   | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT,     Debugger.TYPE_DSSI  | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xA5 */ [Debugger.INS.MOVSW, Debugger.TYPE_ESDI   | Debugger.TYPE_VWORD | Debugger.TYPE_OUT,     Debugger.TYPE_DSSI  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xA6 */ [Debugger.INS.CMPSB, Debugger.TYPE_ESDI   | Debugger.TYPE_BYTE  | Debugger.TYPE_IN,      Debugger.TYPE_DSSI  | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xA7 */ [Debugger.INS.CMPSW, Debugger.TYPE_ESDI   | Debugger.TYPE_VWORD | Debugger.TYPE_IN,      Debugger.TYPE_DSSI  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],

    /* 0xA8 */ [Debugger.INS.TEST,  Debugger.TYPE_AL     | Debugger.TYPE_IN,     Debugger.TYPE_IMM  | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xA9 */ [Debugger.INS.TEST,  Debugger.TYPE_AX     | Debugger.TYPE_IN,     Debugger.TYPE_IMM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xAA */ [Debugger.INS.STOSB, Debugger.TYPE_ESDI   | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT,   Debugger.TYPE_AL    | Debugger.TYPE_IN],
    /* 0xAB */ [Debugger.INS.STOSW, Debugger.TYPE_ESDI   | Debugger.TYPE_VWORD | Debugger.TYPE_OUT,   Debugger.TYPE_AX    | Debugger.TYPE_IN],
    /* 0xAC */ [Debugger.INS.LODSB, Debugger.TYPE_AL     | Debugger.TYPE_OUT,    Debugger.TYPE_DSSI | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xAD */ [Debugger.INS.LODSW, Debugger.TYPE_AX     | Debugger.TYPE_OUT,    Debugger.TYPE_DSSI | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xAE */ [Debugger.INS.SCASB, Debugger.TYPE_AL     | Debugger.TYPE_IN,     Debugger.TYPE_ESDI | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xAF */ [Debugger.INS.SCASW, Debugger.TYPE_AX     | Debugger.TYPE_IN,     Debugger.TYPE_ESDI | Debugger.TYPE_VWORD | Debugger.TYPE_IN],

    /* 0xB0 */ [Debugger.INS.MOV,   Debugger.TYPE_AL     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xB1 */ [Debugger.INS.MOV,   Debugger.TYPE_CL     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xB2 */ [Debugger.INS.MOV,   Debugger.TYPE_DL     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xB3 */ [Debugger.INS.MOV,   Debugger.TYPE_BL     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xB4 */ [Debugger.INS.MOV,   Debugger.TYPE_AH     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xB5 */ [Debugger.INS.MOV,   Debugger.TYPE_CH     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xB6 */ [Debugger.INS.MOV,   Debugger.TYPE_DH     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xB7 */ [Debugger.INS.MOV,   Debugger.TYPE_BH     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],

    /* 0xB8 */ [Debugger.INS.MOV,   Debugger.TYPE_AX     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xB9 */ [Debugger.INS.MOV,   Debugger.TYPE_CX     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xBA */ [Debugger.INS.MOV,   Debugger.TYPE_DX     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xBB */ [Debugger.INS.MOV,   Debugger.TYPE_BX     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xBC */ [Debugger.INS.MOV,   Debugger.TYPE_SP     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xBD */ [Debugger.INS.MOV,   Debugger.TYPE_BP     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xBE */ [Debugger.INS.MOV,   Debugger.TYPE_SI     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xBF */ [Debugger.INS.MOV,   Debugger.TYPE_DI     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],

    /* 0xC0 */ [Debugger.INS.GRP2B, Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH | Debugger.TYPE_80186, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xC1 */ [Debugger.INS.GRP2W, Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH | Debugger.TYPE_80186, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xC2 */ [Debugger.INS.RET,   Debugger.TYPE_IMM    | Debugger.TYPE_WORD  | Debugger.TYPE_IN],
    /* 0xC3 */ [Debugger.INS.RET],
    /* 0xC4 */ [Debugger.INS.LES,   Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_OUT, Debugger.TYPE_MODMEM | Debugger.TYPE_SEGP  | Debugger.TYPE_IN],
    /* 0xC5 */ [Debugger.INS.LDS,   Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_OUT, Debugger.TYPE_MODMEM | Debugger.TYPE_SEGP  | Debugger.TYPE_IN],
    /* 0xC6 */ [Debugger.INS.MOV,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT, Debugger.TYPE_IMM    | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xC7 */ [Debugger.INS.MOV,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_OUT, Debugger.TYPE_IMM    | Debugger.TYPE_VWORD | Debugger.TYPE_IN],

    /* 0xC8 */ [Debugger.INS.ENTER, Debugger.TYPE_IMM    | Debugger.TYPE_WORD  | Debugger.TYPE_IN | Debugger.TYPE_80286,  Debugger.TYPE_IMM   | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xC9 */ [Debugger.INS.LEAVE, Debugger.TYPE_NONE   | Debugger.TYPE_80286],
    /* 0xCA */ [Debugger.INS.RETF,  Debugger.TYPE_IMM    | Debugger.TYPE_WORD  | Debugger.TYPE_IN],
    /* 0xCB */ [Debugger.INS.RETF],
    /* 0xCC */ [Debugger.INS.INT3],
    /* 0xCD */ [Debugger.INS.INT,   Debugger.TYPE_IMM    | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xCE */ [Debugger.INS.INTO],
    /* 0xCF */ [Debugger.INS.IRET],

    /* 0xD0 */ [Debugger.INS.GRP2B1,Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_ONE    | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xD1 */ [Debugger.INS.GRP2W1,Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_ONE    | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xD2 */ [Debugger.INS.GRP2BC,Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL |   Debugger.TYPE_IN],
    /* 0xD3 */ [Debugger.INS.GRP2WC,Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL |   Debugger.TYPE_IN],
    /* 0xD4 */ [Debugger.INS.AAM,   Debugger.TYPE_IMM    | Debugger.TYPE_BYTE],
    /* 0xD5 */ [Debugger.INS.AAD,   Debugger.TYPE_IMM    | Debugger.TYPE_BYTE],
    /* 0xD6 */ [Debugger.INS.SALC],
    /* 0xD7 */ [Debugger.INS.XLAT],

    /* 0xD8 */ [Debugger.INS.ESC,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xD9 */ [Debugger.INS.ESC,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xDA */ [Debugger.INS.ESC,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xDB */ [Debugger.INS.ESC,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xDC */ [Debugger.INS.ESC,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xDD */ [Debugger.INS.ESC,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xDE */ [Debugger.INS.ESC,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xDF */ [Debugger.INS.ESC,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],

    /* 0xE0 */ [Debugger.INS.LOOPNZ,Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xE1 */ [Debugger.INS.LOOPZ, Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xE2 */ [Debugger.INS.LOOP,  Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xE3 */ [Debugger.INS.JCXZ,  Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xE4 */ [Debugger.INS.IN,    Debugger.TYPE_AL     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xE5 */ [Debugger.INS.IN,    Debugger.TYPE_AX     | Debugger.TYPE_OUT,    Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
    /* 0xE6 */ [Debugger.INS.OUT,   Debugger.TYPE_IMM    | Debugger.TYPE_BYTE  | Debugger.TYPE_IN,   Debugger.TYPE_AL   | Debugger.TYPE_IN],
    /* 0xE7 */ [Debugger.INS.OUT,   Debugger.TYPE_IMM    | Debugger.TYPE_BYTE  | Debugger.TYPE_IN,   Debugger.TYPE_AX   | Debugger.TYPE_IN],

    /* 0xE8 */ [Debugger.INS.CALL,  Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xE9 */ [Debugger.INS.JMP,   Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
    /* 0xEA */ [Debugger.INS.JMP,   Debugger.TYPE_IMM    | Debugger.TYPE_FARP  | Debugger.TYPE_IN],
    /* 0xEB */ [Debugger.INS.JMP,   Debugger.TYPE_IMMREL | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
    /* 0xEC */ [Debugger.INS.IN,    Debugger.TYPE_AL     | Debugger.TYPE_OUT,    Debugger.TYPE_DX | Debugger.TYPE_IN],
    /* 0xED */ [Debugger.INS.IN,    Debugger.TYPE_AX     | Debugger.TYPE_OUT,    Debugger.TYPE_DX | Debugger.TYPE_IN],
    /* 0xEE */ [Debugger.INS.OUT,   Debugger.TYPE_DX     | Debugger.TYPE_IN,     Debugger.TYPE_AL | Debugger.TYPE_IN],
    /* 0xEF */ [Debugger.INS.OUT,   Debugger.TYPE_DX     | Debugger.TYPE_IN,     Debugger.TYPE_AX | Debugger.TYPE_IN],

    /* 0xF0 */ [Debugger.INS.LOCK,  Debugger.TYPE_PREFIX],
    /* 0xF1 */ [Debugger.INS.NONE],
    /* 0xF2 */ [Debugger.INS.REPNZ, Debugger.TYPE_PREFIX],
    /* 0xF3 */ [Debugger.INS.REPZ,  Debugger.TYPE_PREFIX],
    /* 0xF4 */ [Debugger.INS.HLT],
    /* 0xF5 */ [Debugger.INS.CMC],
    /* 0xF6 */ [Debugger.INS.GRP3B, Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH],
    /* 0xF7 */ [Debugger.INS.GRP3W, Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH],

    /* 0xF8 */ [Debugger.INS.CLC],
    /* 0xF9 */ [Debugger.INS.STC],
    /* 0xFA */ [Debugger.INS.CLI],
    /* 0xFB */ [Debugger.INS.STI],
    /* 0xFC */ [Debugger.INS.CLD],
    /* 0xFD */ [Debugger.INS.STD],
    /* 0xFE */ [Debugger.INS.GRP4B, Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH],
    /* 0xFF */ [Debugger.INS.GRP4W, Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH]
    ];

    Debugger.aaOp0FDescs = {
        0x00: [Debugger.INS.GRP6,   Debugger.TYPE_MODRM  | Debugger.TYPE_WORD  | Debugger.TYPE_BOTH],
        0x01: [Debugger.INS.GRP7,   Debugger.TYPE_MODRM  | Debugger.TYPE_WORD  | Debugger.TYPE_BOTH],
        0x02: [Debugger.INS.LAR,    Debugger.TYPE_REG    | Debugger.TYPE_WORD  | Debugger.TYPE_OUT  | Debugger.TYPE_80286, Debugger.TYPE_MODMEM | Debugger.TYPE_WORD | Debugger.TYPE_IN],
        0x03: [Debugger.INS.LSL,    Debugger.TYPE_REG    | Debugger.TYPE_WORD  | Debugger.TYPE_OUT  | Debugger.TYPE_80286, Debugger.TYPE_MODMEM | Debugger.TYPE_WORD | Debugger.TYPE_IN],
        0x05: [Debugger.INS.LOADALL,Debugger.TYPE_80286],
        0x06: [Debugger.INS.CLTS,   Debugger.TYPE_80286],
        0x20: [Debugger.INS.MOV,    Debugger.TYPE_MODREG | Debugger.TYPE_DWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_CTLREG | Debugger.TYPE_DWORD | Debugger.TYPE_IN],
        0x21: [Debugger.INS.MOV,    Debugger.TYPE_MODREG | Debugger.TYPE_DWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_DBGREG | Debugger.TYPE_DWORD | Debugger.TYPE_IN],
        0x22: [Debugger.INS.MOV,    Debugger.TYPE_CTLREG | Debugger.TYPE_DWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_MODREG | Debugger.TYPE_DWORD | Debugger.TYPE_IN],
        0x23: [Debugger.INS.MOV,    Debugger.TYPE_DBGREG | Debugger.TYPE_DWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_MODREG | Debugger.TYPE_DWORD | Debugger.TYPE_IN],
        0x24: [Debugger.INS.MOV,    Debugger.TYPE_MODREG | Debugger.TYPE_DWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_TSTREG | Debugger.TYPE_DWORD | Debugger.TYPE_IN],
        0x26: [Debugger.INS.MOV,    Debugger.TYPE_TSTREG | Debugger.TYPE_DWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_MODREG | Debugger.TYPE_DWORD | Debugger.TYPE_IN],
        0x80: [Debugger.INS.JO,     Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x81: [Debugger.INS.JNO,    Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x82: [Debugger.INS.JC,     Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x83: [Debugger.INS.JNC,    Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x84: [Debugger.INS.JZ,     Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x85: [Debugger.INS.JNZ,    Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x86: [Debugger.INS.JBE,    Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x87: [Debugger.INS.JA,     Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x88: [Debugger.INS.JS,     Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x89: [Debugger.INS.JNS,    Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x8A: [Debugger.INS.JP,     Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x8B: [Debugger.INS.JNP,    Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x8C: [Debugger.INS.JL,     Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x8D: [Debugger.INS.JGE,    Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x8E: [Debugger.INS.JLE,    Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x8F: [Debugger.INS.JG,     Debugger.TYPE_IMMREL | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386],
        0x90: [Debugger.INS.SETO,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x91: [Debugger.INS.SETNO,  Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x92: [Debugger.INS.SETC,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x93: [Debugger.INS.SETNC,  Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x94: [Debugger.INS.SETZ,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x95: [Debugger.INS.SETNZ,  Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x96: [Debugger.INS.SETBE,  Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x97: [Debugger.INS.SETNBE, Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x98: [Debugger.INS.SETS,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x99: [Debugger.INS.SETNS,  Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x9A: [Debugger.INS.SETP,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x9B: [Debugger.INS.SETNP,  Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x9C: [Debugger.INS.SETL,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x9D: [Debugger.INS.SETGE,  Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x9E: [Debugger.INS.SETLE,  Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0x9F: [Debugger.INS.SETG,   Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_OUT  | Debugger.TYPE_80386],
        0xA0: [Debugger.INS.PUSH,   Debugger.TYPE_FS     | Debugger.TYPE_IN    | Debugger.TYPE_80386],
        0xA1: [Debugger.INS.POP,    Debugger.TYPE_FS     | Debugger.TYPE_OUT   | Debugger.TYPE_80386],
        0xA3: [Debugger.INS.BT,     Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN   | Debugger.TYPE_80386, Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        0xA4: [Debugger.INS.SHLD,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN, Debugger.TYPE_IMM    | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        0xA5: [Debugger.INS.SHLD,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN, Debugger.TYPE_IMPREG | Debugger.TYPE_CL   | Debugger.TYPE_IN],
        0xA8: [Debugger.INS.PUSH,   Debugger.TYPE_GS     | Debugger.TYPE_IN    | Debugger.TYPE_80386],
        0xA9: [Debugger.INS.POP,    Debugger.TYPE_GS     | Debugger.TYPE_OUT   | Debugger.TYPE_80386],
        0xAB: [Debugger.INS.BTS,    Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        0xAC: [Debugger.INS.SHRD,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN, Debugger.TYPE_IMM    | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        0xAD: [Debugger.INS.SHRD,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN, Debugger.TYPE_IMPREG | Debugger.TYPE_CL   | Debugger.TYPE_IN],
        0xAF: [Debugger.INS.IMUL,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH | Debugger.TYPE_80386, Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        0xB2: [Debugger.INS.LSS,    Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_OUT,                        Debugger.TYPE_MODMEM | Debugger.TYPE_SEGP  | Debugger.TYPE_IN],
        0xB3: [Debugger.INS.BTR,    Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        0xB4: [Debugger.INS.LFS,    Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_OUT,                        Debugger.TYPE_MODMEM | Debugger.TYPE_SEGP  | Debugger.TYPE_IN],
        0xB5: [Debugger.INS.LGS,    Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_OUT,                        Debugger.TYPE_MODMEM | Debugger.TYPE_SEGP  | Debugger.TYPE_IN],
        0xB6: [Debugger.INS.MOVZX,  Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
        0xB7: [Debugger.INS.MOVZX,  Debugger.TYPE_REG    | Debugger.TYPE_DWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_MODRM  | Debugger.TYPE_WORD  | Debugger.TYPE_IN],
        0xBA: [Debugger.INS.GRP8,   Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH | Debugger.TYPE_80386, Debugger.TYPE_IMM    | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
        0xBB: [Debugger.INS.BTC,    Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        0xBC: [Debugger.INS.BSF,    Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        0xBD: [Debugger.INS.BSR,    Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_MODRM  | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        0xBE: [Debugger.INS.MOVSX,  Debugger.TYPE_REG    | Debugger.TYPE_VWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_MODRM  | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
        0xBF: [Debugger.INS.MOVSX,  Debugger.TYPE_REG    | Debugger.TYPE_DWORD | Debugger.TYPE_OUT  | Debugger.TYPE_80386, Debugger.TYPE_MODRM  | Debugger.TYPE_WORD  | Debugger.TYPE_IN]
    };

    Debugger.aaGrpDescs = [
      [
        /* GRP1B */
        [Debugger.INS.ADD,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.OR,   Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.ADC,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.SBB,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.AND,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.SUB,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.XOR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.CMP,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_IN,   Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN]
      ],
      [
        /* GRP1W */
        [Debugger.INS.ADD,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        [Debugger.INS.OR,   Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        [Debugger.INS.ADC,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        [Debugger.INS.SBB,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        [Debugger.INS.AND,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        [Debugger.INS.SUB,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        [Debugger.INS.XOR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        [Debugger.INS.CMP,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN,   Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN]
      ],
      [
        /* GRP1SW */
        [Debugger.INS.ADD,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_SBYTE | Debugger.TYPE_IN],
        [Debugger.INS.OR,   Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_SBYTE | Debugger.TYPE_IN],
        [Debugger.INS.ADC,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_SBYTE | Debugger.TYPE_IN],
        [Debugger.INS.SBB,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_SBYTE | Debugger.TYPE_IN],
        [Debugger.INS.AND,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_SBYTE | Debugger.TYPE_IN],
        [Debugger.INS.SUB,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_SBYTE | Debugger.TYPE_IN],
        [Debugger.INS.XOR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMM | Debugger.TYPE_SBYTE | Debugger.TYPE_IN],
        [Debugger.INS.CMP,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN,   Debugger.TYPE_IMM | Debugger.TYPE_SBYTE | Debugger.TYPE_IN]
      ],
      [
        /* GRP2B */
        [Debugger.INS.ROL,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.ROR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.RCL,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.RCR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.SHL,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.SHR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
         Debugger.aOpDescUndefined,
        [Debugger.INS.SAR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN]
      ],
      [
        /* GRP2W */
        [Debugger.INS.ROL,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.ROR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.RCL,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.RCR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.SHL,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.SHR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
         Debugger.aOpDescUndefined,
        [Debugger.INS.SAR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH | Debugger.TYPE_80286, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN]
      ],
      [
        /* GRP2B1 */
        [Debugger.INS.ROL,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.ROR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.RCL,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.RCR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.SHL,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.SHR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
         Debugger.aOpDescUndefined,
        [Debugger.INS.SAR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN]
      ],
      [
        /* GRP2W1 */
        [Debugger.INS.ROL,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.ROR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.RCL,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.RCR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.SHL,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.SHR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
         Debugger.aOpDescUndefined,
        [Debugger.INS.SAR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_ONE | Debugger.TYPE_BYTE | Debugger.TYPE_IN]
      ],
      [
        /* GRP2BC */
        [Debugger.INS.ROL,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
        [Debugger.INS.ROR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
        [Debugger.INS.RCL,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
        [Debugger.INS.RCR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
        [Debugger.INS.SHL,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
        [Debugger.INS.SHR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
         Debugger.aOpDescUndefined,
        [Debugger.INS.SAR,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN]
      ],
      [
        /* GRP2WC */
        [Debugger.INS.ROL,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
        [Debugger.INS.ROR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
        [Debugger.INS.RCL,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
        [Debugger.INS.RCR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
        [Debugger.INS.SHL,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
        [Debugger.INS.SHR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN],
         Debugger.aOpDescUndefined,
        [Debugger.INS.SAR,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH, Debugger.TYPE_IMPREG | Debugger.TYPE_CL | Debugger.TYPE_IN]
      ],
      [
        /* GRP3B */
        [Debugger.INS.TEST, Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN,   Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
         Debugger.aOpDescUndefined,
        [Debugger.INS.NOT,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH],
        [Debugger.INS.NEG,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH],
        [Debugger.INS.MUL,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
        [Debugger.INS.IMUL, Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH],
        [Debugger.INS.DIV,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_IN],
        [Debugger.INS.IDIV, Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH]
      ],
      [
        /* GRP3W */
        [Debugger.INS.TEST, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN,   Debugger.TYPE_IMM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
         Debugger.aOpDescUndefined,
        [Debugger.INS.NOT,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH],
        [Debugger.INS.NEG,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH],
        [Debugger.INS.MUL,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        [Debugger.INS.IMUL, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH],
        [Debugger.INS.DIV,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        [Debugger.INS.IDIV, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH]
      ],
      [
        /* GRP4B */
        [Debugger.INS.INC,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH],
        [Debugger.INS.DEC,  Debugger.TYPE_MODRM | Debugger.TYPE_BYTE  | Debugger.TYPE_BOTH],
         Debugger.aOpDescUndefined,
         Debugger.aOpDescUndefined,
         Debugger.aOpDescUndefined,
         Debugger.aOpDescUndefined,
         Debugger.aOpDescUndefined,
         Debugger.aOpDescUndefined
      ],
      [
        /* GRP4W */
        [Debugger.INS.INC,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH],
        [Debugger.INS.DEC,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_BOTH],
        [Debugger.INS.CALL, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        [Debugger.INS.CALL, Debugger.TYPE_MODRM | Debugger.TYPE_FARP  | Debugger.TYPE_IN],
        [Debugger.INS.JMP,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
        [Debugger.INS.JMP,  Debugger.TYPE_MODRM | Debugger.TYPE_FARP  | Debugger.TYPE_IN],
        [Debugger.INS.PUSH, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN],
         Debugger.aOpDescUndefined
      ],
      [ /* OP0F */ ],
      [
        /* GRP6 */
        [Debugger.INS.SLDT, Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_OUT | Debugger.TYPE_80286],
        [Debugger.INS.STR,  Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_OUT | Debugger.TYPE_80286],
        [Debugger.INS.LLDT, Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_IN  | Debugger.TYPE_80286],
        [Debugger.INS.LTR,  Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_IN  | Debugger.TYPE_80286],
        [Debugger.INS.VERR, Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_IN  | Debugger.TYPE_80286],
        [Debugger.INS.VERW, Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_IN  | Debugger.TYPE_80286],
         Debugger.aOpDescUndefined,
         Debugger.aOpDescUndefined
      ],
      [
        /* GRP7 */
        [Debugger.INS.SGDT, Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_OUT | Debugger.TYPE_80286],
        [Debugger.INS.SIDT, Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_OUT | Debugger.TYPE_80286],
        [Debugger.INS.LGDT, Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_IN  | Debugger.TYPE_80286],
        [Debugger.INS.LIDT, Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_IN  | Debugger.TYPE_80286],
        [Debugger.INS.SMSW, Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_OUT | Debugger.TYPE_80286],
         Debugger.aOpDescUndefined,
        [Debugger.INS.LMSW, Debugger.TYPE_MODRM | Debugger.TYPE_WORD | Debugger.TYPE_IN  | Debugger.TYPE_80286],
         Debugger.aOpDescUndefined
      ],
      [
        /* GRP8 */
         Debugger.aOpDescUndefined,
         Debugger.aOpDescUndefined,
         Debugger.aOpDescUndefined,
         Debugger.aOpDescUndefined,
        [Debugger.INS.BT,  Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_IN  | Debugger.TYPE_80386, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.BTS, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_OUT | Debugger.TYPE_80386, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.BTR, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_OUT | Debugger.TYPE_80386, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN],
        [Debugger.INS.BTC, Debugger.TYPE_MODRM | Debugger.TYPE_VWORD | Debugger.TYPE_OUT | Debugger.TYPE_80386, Debugger.TYPE_IMM | Debugger.TYPE_BYTE | Debugger.TYPE_IN]
      ]
    ];

    /**
     * initBus(bus, cpu, dbg)
     *
     * @this {Debugger}
     * @param {Computer} cmp
     * @param {Bus} bus
     * @param {X86CPU} cpu
     * @param {Debugger} dbg
     */
    Debugger.prototype.initBus = function(cmp, bus, cpu, dbg)
    {
        this.bus = bus;
        this.cpu = cpu;
        this.cmp = cmp;
        this.fdc = cmp.getComponentByType("FDC");
        this.hdc = cmp.getComponentByType("HDC");
        this.mouse = cmp.getComponentByType("Mouse");
        if (MAXDEBUG) this.chipset = cmp.getComponentByType("ChipSet");

        this.cchAddr = bus.getWidth() >> 2;
        this.maskAddr = bus.nBusLimit;

        /*
         * Allocate a special segment "register" for our own use, whenever a requested selector is not currently loaded
         */
        this.segDebugger = new X86Seg(this.cpu, X86Seg.ID.DBG, "DBG");

        this.aaOpDescs = Debugger.aaOpDescs;
        if (this.cpu.model >= X86.MODEL_80186) {
            this.aaOpDescs = Debugger.aaOpDescs.slice();
            this.aaOpDescs[0x0F] = Debugger.aOpDescUndefined;
            if (this.cpu.model >= X86.MODEL_80286) {
                this.aaOpDescs[0x0F] = Debugger.aOpDesc0F;
                if (I386 && this.cpu.model >= X86.MODEL_80386) {
                    this.cchReg = 8;
                    this.maskReg = 0xffffffff|0;
                }
            }
        }

        this.messageDump(Messages.BUS,  function onDumpBus(asArgs)  { dbg.dumpBus(asArgs); });
        this.messageDump(Messages.MEM,  function onDumpMem(asArgs)  { dbg.dumpMem(asArgs); });
        this.messageDump(Messages.DESC, function onDumpDesc(asArgs) { dbg.dumpDesc(asArgs); });
        this.messageDump(Messages.TSS,  function onDumpTSS(asArgs)  { dbg.dumpTSS(asArgs); });
        this.messageDump(Messages.DOS,  function onDumpDOS(asArgs)  { dbg.dumpDOS(asArgs); });

        if (Interrupts.WINDBG.ENABLED || Interrupts.WINDBGRM.ENABLED) {
            this.fWinDbg = null;
            this.cpu.addIntNotify(Interrupts.WINDBG.VECTOR, this.intWindowsDebugger.bind(this));
        }
        if (Interrupts.WINDBGRM.ENABLED) {
            this.fWinDbgRM = null;
            this.cpu.addIntNotify(Interrupts.WINDBGRM.VECTOR, this.intWindowsDebuggerRM.bind(this));
        }

        this.setReady();
    };

    if (Interrupts.WINDBG.ENABLED || Interrupts.WINDBGRM.ENABLED) {
        /**
         * intWindowsDebugger()
         *
         * This intercepts calls to the Windows Debugger protected-mode interface (INT 0x41).
         *
         * It's enabled if Interrupts.WINDBG.ENABLED is true, but it must ALSO be enabled if
         * Interrupts.WINDBGRM.ENABLED is true, because if the latter decides to respond to
         * requests, then we must start responding, too, because Windows assumes that the former
         * is installed whenever it detects the latter.
         *
         * Which is also why intWindowsDebuggerRM() will also set this.fWinDbg to true: we MUST
         * return false for all INT 0x41 requests, so that all requests are consumed, since there's
         * no guarantee that a valid interrupt handler exists inside the machine.
         *
         * @this {Debugger}
         * @param {number} addr
         * @return {boolean} true to proceed with the INT 0x41 software interrupt, false to skip
         */
        Debugger.prototype.intWindowsDebugger = function(addr)
        {
            var cpu = this.cpu;
            var AX = cpu.regEAX & 0xffff;
            var BX = cpu.regEBX & 0xffff;
            var CX = cpu.regECX & 0xffff;
            var DX = cpu.regEDX & 0xffff;
            var SI = cpu.regESI & 0xffff;
            var DI = cpu.regEDI & 0xffff;
            var ES = cpu.segES.sel;

            var seg, limit, sModule;

            if (this.fWinDbg == null) {
                if (AX == Interrupts.WINDBG.IS_LOADED) {
                    /*
                     * We're only going to respond to this function if no one else did, in which case,
                     * we'll set fWinDbg to true and handle additional notifications.
                     */
                    cpu.addIntReturn(addr, function(dbg) {
                        return function onInt41Return(nLevel) {
                            if ((cpu.regEAX & 0xffff) != Interrupts.WINDBG.LOADED) {
                                cpu.regEAX = (cpu.regEAX & ~0xffff) | Interrupts.WINDBG.LOADED;
                                dbg.println("INT 0x41 handling enabled");
                                dbg.fWinDbg = true;
                            } else {
                                dbg.println("INT 0x41 monitoring enabled");
                                dbg.fWinDbg = false;
                            }
                        };
                    }(this));
                }
                return true;
            }

            /*
             * NOTE: If this.fWinDbg is true, then all cases should return false, because we're taking full
             * responsibility for all requests (don't assume there's valid interrupt handler inside the machine).
             */
            switch(AX) {
            case Interrupts.WINDBG.IS_LOADED:
                if (this.fWinDbg) {
                    cpu.regEAX = (cpu.regEAX & ~0xffff) | Interrupts.WINDBG.LOADED;
                    return false;
                }
                break;

            case Interrupts.WINDBG.LOAD_SEG:
                /*
                 * The following output should completely mimic WDEB386....
                 */
                sModule = this.getSZ(this.newAddr(DI, ES));
                limit = (seg = this.getSegment(CX))? seg.limit : 0;
                if (this.fWinDbg) {
                    this.println(sModule + "!undefined " + ((SI & 0x1)? "data" : "code") + '(' + str.toHex(BX+1, 4) + ")=#" + str.toHex(CX, 4) + " len " + str.toHex(limit+1));
                    return false;
                }
                break;

            default:
                if (this.fWinDbg) {
                    this.println("INT 0x41: " + str.toHexWord(AX));
                    return false;
                }
                break;
            }

            return true;
        };
    }

    if (Interrupts.WINDBGRM.ENABLED) {
        /**
         * intWindowsDebuggerRM()
         *
         * This intercepts calls to the Windows Debugger real-mode interface (INT 0x68).
         *
         * @this {Debugger}
         * @param {number} addr
         * @return {boolean} true to proceed with the INT 0x68 software interrupt, false to skip
         */
        Debugger.prototype.intWindowsDebuggerRM = function(addr)
        {
            var dbgAddr;
            var cpu = this.cpu;
            var AL = cpu.regEAX & 0xff;
            var AH = (cpu.regEAX >> 8) & 0xff;
            var DI = cpu.regEDI & 0xffff;
            var ES = cpu.segES.sel;

            if (this.fWinDbgRM == null) {
                if (AH == Interrupts.WINDBGRM.IS_LOADED) {
                    /*
                     * We're only going to respond to this function if no one else did, in which case,
                     * we'll set fWinDbgRM to true and handle additional notifications.
                     */
                    cpu.addIntReturn(addr, function(dbg) {
                        return function onInt68Return(nLevel) {
                            if ((cpu.regEAX & 0xffff) != Interrupts.WINDBGRM.LOADED) {
                                cpu.regEAX = (cpu.regEAX & ~0xffff) | Interrupts.WINDBGRM.LOADED;
                                dbg.println("INT 0x68 handling enabled");
                                /*
                                 * If we turn on INT 0x68 handling, we must also turn on INT 0x41 handling,
                                 * because Windows assumes that the latter handler exists whenever the former does.
                                 */
                                dbg.fWinDbg = dbg.fWinDbgRM = true;
                            } else {
                                dbg.println("INT 0x68 monitoring enabled");
                                dbg.fWinDbgRM = false;
                            }
                        };
                    }(this));
                }
                return true;
            }

            switch(AH) {
            case Interrupts.WINDBGRM.IS_LOADED:
                if (this.fWinDbgRM) {
                    cpu.regEAX = (cpu.regEAX & ~0xffff) | Interrupts.WINDBGRM.LOADED;
                    return false;
                }
                break;

            case Interrupts.WINDBGRM.PREP_PMODE:
                if (this.fWinDbgRM) {
                    var a = cpu.segCS.addCallBreak(this.callWindowsDebuggerPMInit.bind(this));
                    if (a) {
                        cpu.regEDI = a[0];
                        cpu.setES(a[1]);
                    }
                }
                return false;

            case Interrupts.WINDBGRM.LOAD_SEG:
                if (AL == 0x20) {
                    /*
                     *  Real-mode EXE
                     *  CX == paragraph
                     *  ES:DI -> module name
                     */
                }
                else if (AL < 0x80) {
                    /*
                     *  AL == segment type:
                     *      0x00    code selector
                     *      0x01    data selector
                     *      0x10    code segment
                     *      0x11    data segment
                     *      0x40    code segment & sel
                     *      0x41    data segment & sel
                     *  BX == segment #
                     *  CX == actual segment/selector
                     *  DX == actual selector (if 0x40 or 0x41)
                     *  ES:DI -> module name
                     */
                }
                else {
                    /*
                     *  AL == segment type:
                     *      0x80    device driver code seg
				     *      0x81    device driver data seg
                     *  ES:DI -> D386_Device_Params structure:
                     *      DD_logical_seg  dw  ?   ; logical segment # from map
                     *      DD_actual_sel   dw  ?   ; actual selector value
                     *      DD_base         dd  ?   ; linear address offset for start of segment
                     *      DD_length       dd  ?   ; actual length of segment
                     *      DD_name         df  ?   ; 16:32 ptr to null terminated device name
                     *      DD_sym_name     df  ?   ; 16:32 ptr to null terminated symbolic module name (i.e. Win386)
                     *      DD_alias_sel    dw  ?   ; alias selector value (0 = none)
                     */
                    dbgAddr = this.newAddr(DI, ES);
                    var nSeg = this.getShort(dbgAddr, 2);
                    var sel = this.getShort(dbgAddr, 2);
                    var off = this.getLong(dbgAddr, 4);
                    var len = this.getLong(dbgAddr, 4);
                    var dbgAddrDevice = this.newAddr(this.getLong(dbgAddr, 4), this.getShort(dbgAddr, 2));
                    var dbgAddrModule = this.newAddr(this.getLong(dbgAddr, 4), this.getShort(dbgAddr, 2));
                    var selAlias = this.getShort(dbgAddr, 2) || sel;
                    if (this.fWinDbgRM) {
                        this.println(this.getSZ(dbgAddrModule) + '!' + this.getSZ(dbgAddrDevice) + "!undefined " + ((AL & 0x1)? "data" : "code") + '(' + str.toHex(nSeg, 4) + ")=" + str.toHex(selAlias, 4) + ':' + str.toHex(off) + " len " + str.toHex(len));
                    }
                }
                if (this.fWinDbgRM) {
                    cpu.regEAX = (cpu.regEAX & ~0xff) | 0x01;
                    return false;
                }
                break;

            default:
                if (this.fWinDbgRM) {
                    this.println("INT 0x68: " + str.toHexByte(AH));
                    return false;
                }
                break;
            }

            return true;
        };

        /**
         * callWindowsDebuggerPMInit()
         *
         * This intercepts calls to the Windows Debugger "PMInit" interface; eg:
         *
         *      AL = function code
         *
         *          0 - initialize IDT
         *              ES:EDI points to protected mode IDT
         *
         *          1 - initialize page checking
         *              BX = physical selector
         *              ECX = linear bias
         *
         *          2 - specify that debug queries are supported
         *
         *          3 - initialize spare PTE
         *              EBX = linear address of spare PTE
         *              EDX = linear address the PTE represents
         *
         *          4 - set Enter/Exit VMM routine address
         *              EBX = Enter VMM routine address
         *              ECX = Exit VMM routine address
         *              EDX = $_Debug_Out_Service address
         *              ESI = $_Trace_Out_Service address
         *              The VMM enter/exit routines must return with a retfd
         *
         *          5 - get debugger size/physical address
         *              returns: AL = 0 (don't call AL = 1)
         *              ECX = size in bytes
         *              ESI = starting physical code/data address
         *
         *          6 - set debugger base/initialize spare PTE
         *              EBX = linear address of spare PTE
         *              EDX = linear address the PTE represents
         *              ESI = starting linear address of debug code/data
         *
         *          7 - enable memory context functions
         *
         * @this {Debugger}
         * @return {boolean} (must always return false to skip the call, because the call is using a CALLBREAK address)
         */
        Debugger.prototype.callWindowsDebuggerPMInit = function()
        {
            var cpu = this.cpu;
            var AL = cpu.regEAX & 0xff;
            this.println("INT 0x68 callback: " + str.toHexByte(AL));
            if (AL == 5) {
                cpu.regECX = cpu.regESI = 0;            // our in-machine debugger footprint is zero
                cpu.regEAX = (cpu.regEAX & ~0xff) | 0x01;
            }
            return false;
        }
    }

    /**
     * setBinding(sHTMLType, sBinding, control)
     *
     * @this {Debugger}
     * @param {string|null} sHTMLType is the type of the HTML control (eg, "button", "list", "text", "submit", "textarea", "canvas")
     * @param {string} sBinding is the value of the 'binding' parameter stored in the HTML control's "data-value" attribute (eg, "debugInput")
     * @param {Object} control is the HTML control DOM object (eg, HTMLButtonElement)
     * @return {boolean} true if binding was successful, false if unrecognized binding request
     */
    Debugger.prototype.setBinding = function(sHTMLType, sBinding, control)
    {
        var dbg = this;
        switch (sBinding) {

        case "debugInput":
            this.bindings[sBinding] = control;
            this.controlDebug = control;
            /*
             * For halted machines, this is fine, but for auto-start machines, it can be annoying.
             *
             *      control.focus();
             */
            control.onkeydown = function onKeyDownDebugInput(event) {
                var sInput;
                if (event.keyCode == Keyboard.KEYCODE.CR) {
                    sInput = control.value;
                    control.value = "";
                    var a = dbg.parseCommand(sInput, true);
                    for (var s in a) dbg.doCommand(a[s]);
                }
                else if (event.keyCode == Keyboard.KEYCODE.ESC) {
                    control.value = sInput = "";
                }
                else {
                    if (event.keyCode == Keyboard.KEYCODE.UP) {
                        if (dbg.iPrevCmd < dbg.aPrevCmds.length - 1) {
                            sInput = dbg.aPrevCmds[++dbg.iPrevCmd];
                        }
                    }
                    else if (event.keyCode == Keyboard.KEYCODE.DOWN) {
                        if (dbg.iPrevCmd > 0) {
                            sInput = dbg.aPrevCmds[--dbg.iPrevCmd];
                        } else {
                            sInput = "";
                            dbg.iPrevCmd = -1;
                        }
                    }
                    if (sInput != null) {
                        var cch = sInput.length;
                        control.value = sInput;
                        control.setSelectionRange(cch, cch);
                    }
                }
                if (sInput != null && event.preventDefault) event.preventDefault();
            };
            return true;

        case "debugEnter":
            this.bindings[sBinding] = control;
            web.onClickRepeat(
                control,
                500, 100,
                function onClickDebugEnter(fRepeat) {
                    if (dbg.controlDebug) {
                        var sInput = dbg.controlDebug.value;
                        dbg.controlDebug.value = "";
                        var a = dbg.parseCommand(sInput, true);
                        for (var s in a) dbg.doCommand(a[s]);
                        return true;
                    }
                    if (DEBUG) dbg.log("no debugger input buffer");
                    return false;
                }
            );
            return true;

        case "step":
            this.bindings[sBinding] = control;
            web.onClickRepeat(
                control,
                500, 100,
                function onClickStep(fRepeat) {
                    var fCompleted = false;
                    if (!dbg.isBusy(true)) {
                        dbg.setBusy(true);
                        fCompleted = dbg.stepCPU(fRepeat? 1 : 0);
                        dbg.setBusy(false);
                    }
                    return fCompleted;
                }
            );
            return true;

        default:
            break;
        }
        return false;
    };

    /**
     * setFocus()
     *
     * @this {Debugger}
     */
    Debugger.prototype.setFocus = function()
    {
        if (this.controlDebug) this.controlDebug.focus();
    };

    /**
     * getCurrentMode()
     *
     * @this {Debugger}
     * @return {boolean} (true if protected mode, false if not)
     */
    Debugger.prototype.getCurrentMode = function()
    {
        return this.cpu && !!(this.cpu.regCR0 & X86.CR0.MSW.PE) && !(this.cpu.regPS & X86.PS.VM);
    };

    /**
     * getCurrentType()
     *
     * @this {Debugger}
     * @return {number}
     */
    Debugger.prototype.getCurrentType = function()
    {
        return this.getCurrentMode()? Debugger.ADDR.PROT : Debugger.ADDR.REAL;
    };

    /**
     * getSegment(sel, type)
     *
     * If the selector matches that of any of the CPU segment registers, then return the CPU's segment
     * register, instead of using our own segDebugger segment register.  This makes it possible for us to
     * see what the CPU is seeing at certain critical junctures, such as after an LMSW instruction has
     * switched the processor from real to protected mode.  Actually loading the selector from the GDT/LDT
     * should be done only as a last resort.
     *
     * @this {Debugger}
     * @param {number|null|undefined} sel
     * @param {number} [type] (defaults to getCurrentType())
     * @return {X86Seg|null} seg
     */
    Debugger.prototype.getSegment = function(sel, type)
    {
        var typeDefault = this.getCurrentType();

        if (!type) type = typeDefault;

        if (type == typeDefault) {
            if (sel === this.cpu.getCS()) return this.cpu.segCS;
            if (sel === this.cpu.getDS()) return this.cpu.segDS;
            if (sel === this.cpu.getES()) return this.cpu.segES;
            if (sel === this.cpu.getSS()) return this.cpu.segSS;
            if (I386 && this.cpu.model >= X86.MODEL_80386) {
                if (sel === this.cpu.getFS()) return this.cpu.segFS;
                if (sel === this.cpu.getGS()) return this.cpu.segGS;
            }
            /*
             * Even if nSuppressBreaks is set, we'll allow the call in real-mode,
             * because a loadReal() request using segDebugger should generally be safe.
             */
            if (this.nSuppressBreaks && type == Debugger.ADDR.PROT || !this.segDebugger) return null;
        }
        var seg = this.segDebugger;
        if (type != Debugger.ADDR.PROT) {
            seg.loadReal(sel);
            seg.limit = 0xffff;         // although an ACTUAL real-mode segment load would not modify the limit,
            seg.offMax = 0x10000;       // proper segDebugger operation requires that we update the limit ourselves
        } else {
            seg.probeDesc(sel);
        }
        return seg;
    };

    /**
     * getAddr(dbgAddr, fWrite, nb)
     *
     * @this {Debugger}
     * @param {DbgAddr|null|undefined} dbgAddr
     * @param {boolean} [fWrite]
     * @param {number} [nb] number of bytes to check (1, 2 or 4); default is 1
     * @return {number} is the corresponding linear address, or X86.ADDR_INVALID
     */
    Debugger.prototype.getAddr = function(dbgAddr, fWrite, nb)
    {
        /*
         * Some addresses (eg, breakpoint addresses) save their original linear address in dbgAddr.addr,
         * so we want to use that if it's there, but otherwise, dbgAddr is assumed to be a segmented address
         * whose linear address must always be (re)calculated based on current machine state (mode, active
         * descriptor tables, etc).
         */
        var addr = dbgAddr && dbgAddr.addr;
        if (addr == null) {
            addr = X86.ADDR_INVALID;
            if (dbgAddr) {
                /*
                 * TODO: We should try to cache the seg inside dbgAddr, to avoid unnecessary calls to getSegment().
                 */
                var seg = this.getSegment(dbgAddr.sel, dbgAddr.type);
                if (seg) {
                    if (!fWrite) {
                        addr = seg.checkReadDebugger(dbgAddr.off || 0, nb || 1);
                    } else {
                        addr = seg.checkWriteDebugger(dbgAddr.off || 0, nb || 1);
                    }
                    dbgAddr.addr = addr;
                }
            }
        }
        return addr;
    };

    /**
     * getByte(dbgAddr, inc)
     *
     * We must route all our memory requests through the CPU now, in case paging is enabled.
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {number} [inc]
     * @return {number}
     */
    Debugger.prototype.getByte = function(dbgAddr, inc)
    {
        var b = 0xff;
        var addr = this.getAddr(dbgAddr, false, 1);
        if (addr !== X86.ADDR_INVALID) {
            b = this.cpu.probeAddr(addr) | 0;
            if (inc) this.incAddr(dbgAddr, inc);
        }
        return b;
    };

    /**
     * getWord(dbgAddr, fAdvance)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {boolean} [fAdvance]
     * @return {number}
     */
    Debugger.prototype.getWord = function(dbgAddr, fAdvance)
    {
        if (!dbgAddr.fData32) {
            return this.getShort(dbgAddr, fAdvance? 2 : 0);
        }
        return this.getLong(dbgAddr, fAdvance? 4 : 0);
    };

    /**
     * getShort(dbgAddr, inc)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {number} [inc]
     * @return {number}
     */
    Debugger.prototype.getShort = function(dbgAddr, inc)
    {
        var w = 0xffff;
        var addr = this.getAddr(dbgAddr, false, 2);
        if (addr !== X86.ADDR_INVALID) {
            w = this.cpu.probeAddr(addr) | (this.cpu.probeAddr(addr + 1) << 8);
            if (inc) this.incAddr(dbgAddr, inc);
        }
        return w;
    };

    /**
     * getLong(dbgAddr, inc)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {number} [inc]
     * @return {number}
     */
    Debugger.prototype.getLong = function(dbgAddr, inc)
    {
        var l = -1;
        var addr = this.getAddr(dbgAddr, false, 4);
        if (addr !== X86.ADDR_INVALID) {
            l = this.cpu.probeAddr(addr) | (this.cpu.probeAddr(addr + 1) << 8) | (this.cpu.probeAddr(addr + 2) << 16) | (this.cpu.probeAddr(addr + 3) << 24);
            if (inc) this.incAddr(dbgAddr, inc);
        }
        return l;
    };

    /**
     * setByte(dbgAddr, b, inc)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {number} b
     * @param {number} [inc]
     */
    Debugger.prototype.setByte = function(dbgAddr, b, inc)
    {
        var addr = this.getAddr(dbgAddr, true, 1);
        if (addr !== X86.ADDR_INVALID) {
            this.cpu.setByte(addr, b);
            if (inc) this.incAddr(dbgAddr, inc);
            this.cpu.updateCPU(true);           // we set fForce to true in case video memory was the target
        }
    };

    /**
     * setShort(dbgAddr, w, inc)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {number} w
     * @param {number} [inc]
     */
    Debugger.prototype.setShort = function(dbgAddr, w, inc)
    {
        var addr = this.getAddr(dbgAddr, true, 2);
        if (addr !== X86.ADDR_INVALID) {
            this.cpu.setShort(addr, w);
            if (inc) this.incAddr(dbgAddr, inc);
            this.cpu.updateCPU(true);           // we set fForce to true in case video memory was the target
        }
    };

    /**
     * newAddr(off, sel, addr, type, fData32, fAddr32)
     *
     * Returns a NEW DbgAddr object, initialized with specified values and/or defaults.
     *
     * @this {Debugger}
     * @param {number|null|undefined} [off] (default is zero)
     * @param {number|null|undefined} [sel] (default is undefined)
     * @param {number|null|undefined} [addr] (default is undefined)
     * @param {number} [type] (default is based on current CPU mode)
     * @param {boolean} [fData32] (default is the current CPU operand size)
     * @param {boolean} [fAddr32] (default is the current CPU address size)
     * @return {DbgAddr}
     */
    Debugger.prototype.newAddr = function(off, sel, addr, type, fData32, fAddr32)
    {
        return this.setAddr({}, off, sel, addr, type, fData32, fAddr32);
    };

    /**
     * getAddrPrefix(dbgAddr)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @return {string}
     */
    Debugger.prototype.getAddrPrefix = function(dbgAddr)
    {
        var ch = '';
        switch (dbgAddr.type) {
        case Debugger.ADDR.REAL:
        case Debugger.ADDR.V86:
            ch = '&';
            break;
        case Debugger.ADDR.PROT:
            ch = '#';
            break;
        case Debugger.ADDR.LINEAR:
            ch = '%';
            break;
        }
        return ch;
    };

    /**
     * setAddr(dbgAddr, off, sel, addr, type, fData32, fAddr32)
     *
     * Updates an EXISTING DbgAddr object, initialized with specified values and/or defaults.
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {number|null|undefined} [off] (default is zero)
     * @param {number|null|undefined} [sel] (default is undefined)
     * @param {number|null|undefined} [addr] (default is undefined)
     * @param {number} [type] (default is based on current CPU mode)
     * @param {boolean} [fData32] (default is the current CPU operand size)
     * @param {boolean} [fAddr32] (default is the current CPU address size)
     * @return {DbgAddr}
     */
    Debugger.prototype.setAddr = function(dbgAddr, off, sel, addr, type, fData32, fAddr32)
    {
        dbgAddr.off = off || 0;
        dbgAddr.sel = sel;
        dbgAddr.addr = addr;
        dbgAddr.type = type || this.getCurrentType();
        dbgAddr.fData32 = (fData32 != null)? fData32 : (this.cpu && this.cpu.segCS.sizeData == 4);
        dbgAddr.fAddr32 = (fAddr32 != null)? fAddr32 : (this.cpu && this.cpu.segCS.sizeAddr == 4);
        dbgAddr.fTempBreak = false;
        return dbgAddr;
    };

    /**
     * packAddr(dbgAddr)
     *
     * Packs a DbgAddr object into an Array suitable for saving in a machine state object.
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @return {Array}
     */
    Debugger.prototype.packAddr = function(dbgAddr)
    {
        return [dbgAddr.off, dbgAddr.sel, dbgAddr.addr, dbgAddr.fTempBreak, dbgAddr.fData32, dbgAddr.fAddr32, dbgAddr.cOverrides, dbgAddr.fComplete];
    };

    /**
     * unpackAddr(aAddr)
     *
     * Unpacks a DbgAddr object from an Array created by packAddr() and restored from a saved machine state.
     *
     * @this {Debugger}
     * @param {Array} aAddr
     * @return {DbgAddr}
     */
    Debugger.prototype.unpackAddr = function(aAddr)
    {
        return {off: aAddr[0], sel: aAddr[1], addr: aAddr[2], fTempBreak: aAddr[3], fData32: aAddr[4], fAddr32: aAddr[5], cOverrides: aAddr[6], fComplete: aAddr[7]};
    };

    /**
     * checkLimit(dbgAddr, fUpdate)
     *
     * Used by incAddr() and parseAddr() to ensure that the (updated) dbgAddr offset is within segment bounds.
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {boolean} [fUpdate] (true to update segment info)
     * @return {boolean}
     */
    Debugger.prototype.checkLimit = function(dbgAddr, fUpdate)
    {
        if (dbgAddr.sel != null) {
            var seg = this.getSegment(dbgAddr.sel, dbgAddr.type);
            if (seg) {
                var off = dbgAddr.off & seg.maskAddr;
                if ((off >>> 0) >= seg.offMax) return false;
                if (fUpdate) {
                    dbgAddr.off = off;
                    dbgAddr.fData32 = (seg.sizeData == 4);
                    dbgAddr.fAddr32 = (seg.sizeAddr == 4);
                }
            }
        }
        return true;
    };

    /**
     * incAddr(dbgAddr, inc)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {number} [inc] contains value to increment dbgAddr by (default is 1)
     */
    Debugger.prototype.incAddr = function(dbgAddr, inc)
    {
        inc = inc || 1;
        if (dbgAddr.addr != null) {
            dbgAddr.addr += inc;
        }
        if (dbgAddr.sel != null) {
            dbgAddr.off += inc;
            if (!this.checkLimit(dbgAddr)) {
                dbgAddr.off = 0;
                dbgAddr.addr = null;
            }
        }
    };

    /**
     * hexOffset(off, sel, fAddr32)
     *
     * @this {Debugger}
     * @param {number|null|undefined} [off]
     * @param {number|null|undefined} [sel]
     * @param {boolean} [fAddr32] is true for 32-bit ADDRESS size
     * @return {string} the hex representation of off (or sel:off)
     */
    Debugger.prototype.hexOffset = function(off, sel, fAddr32)
    {
        if (sel != null) {
            return str.toHex(sel, 4) + ':' + str.toHex(off, (off & ~0xffff) || fAddr32? 8 : 4);
        }
        return str.toHex(off);
    };

    /**
     * hexAddr(dbgAddr)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @return {string} the hex representation of the address
     */
    Debugger.prototype.hexAddr = function(dbgAddr)
    {
        var ch = this.getAddrPrefix(dbgAddr);
        return dbgAddr.sel == null? ('%' + str.toHex(dbgAddr.addr)) : (ch + this.hexOffset(dbgAddr.off, dbgAddr.sel, dbgAddr.fAddr32));
    };

    /**
     * getSZ(dbgAddr, cchMax)
     *
     * Gets zero-terminated (aka "ASCIIZ") string from dbgAddr.  It also stops at the first '$', in case this is
     * a '$'-terminated string -- mainly because I'm lazy and didn't feel like writing a separate get() function.
     * Yes, a zero-terminated string containing a '$' will be prematurely terminated, and no, I don't care.
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {number} [cchMax] (default is 256)
     * @return {string} (and dbgAddr advanced past the terminating zero)
     */
    Debugger.prototype.getSZ = function(dbgAddr, cchMax)
    {
        var s = "";
        cchMax = cchMax || 256;
        while (s.length < cchMax) {
            var b = this.getByte(dbgAddr, 1);
            if (!b || b == 0x24 || b >= 127) break;
            s += (b >= 32? String.fromCharCode(b) : '.');
        }
        return s;
    };

    /**
     * dumpDOS(asArgs)
     *
     * Dumps DOS MCBs (Memory Control Blocks).
     *
     * TODO: Add some code to detect the current version of DOS (if any) and locate the first MCB automatically.
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs
     */
    Debugger.prototype.dumpDOS = function(asArgs)
    {
        var mcb;
        var sMCB = asArgs[0];
        if (sMCB) {
            mcb = this.parseValue(sMCB);
        }
        if (mcb === undefined) {
            this.println("invalid MCB");
            return;
        }
        this.println("dumpMCB(" + str.toHexWord(mcb) + ')');
        while (mcb) {
            var dbgAddr = this.newAddr(0, mcb);
            var bSig = this.getByte(dbgAddr, 1);
            var wPID = this.getShort(dbgAddr, 2);
            var wParas = this.getShort(dbgAddr, 5);
            if (bSig != 0x4D && bSig != 0x5A) break;
            this.println(this.hexOffset(0, mcb) + ": '" + String.fromCharCode(bSig) + "' PID=" + str.toHexWord(wPID) + " LEN=" + str.toHexWord(wParas) + ' "' + this.getSZ(dbgAddr, 8) + '"');
            mcb += 1 + wParas;
        }
    };

    /**
     * dumpBlocks(aBlocks, sAddr)
     *
     * @this {Debugger}
     * @param {Array} aBlocks
     * @param {string} [sAddr] (optional block address)
     */
    Debugger.prototype.dumpBlocks = function(aBlocks, sAddr)
    {
        var i = 0, n = aBlocks.length;

        if (sAddr) {
            var addr = this.getAddr(this.parseAddr(sAddr));
            if (addr == X86.ADDR_INVALID) {
                this.println("invalid address: " + sAddr);
                return;
            }
            i = addr >>> this.cpu.nBlockShift;
            n = 1;
        }

        this.println("id       physaddr   blkaddr   used    size    type");
        this.println("-------- ---------  --------  ------  ------  ----");

        while (n--) {
            var block = aBlocks[i];
            if (block.type !== Memory.TYPE.NONE) {
                this.println(str.toHex(block.id) + " %" + str.toHex(i << this.cpu.nBlockShift) + ": " + str.toHex(block.addr) + "  " + str.toHexWord(block.used) + "  " + str.toHexWord(block.size) + "  " + Memory.TYPE.NAMES[block.type]);
            }
            i++;
        }
    };

    /**
     * dumpBus(asArgs)
     *
     * Dumps Bus allocations.
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs (asArgs[0] is an optional block address)
     */
    Debugger.prototype.dumpBus = function(asArgs)
    {
        this.dumpBlocks(this.cpu.aBusBlocks, asArgs[0]);
    };

    /**
     * dumpInfo(asArgs)
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs
     */
    Debugger.prototype.dumpInfo = function(asArgs)
    {
        var sInfo = "no information";
        if (BACKTRACK) {
            var sAddr = asArgs[0];
            var dbgAddr = this.parseAddr(sAddr, Debugger.ADDR.CODE, true, true);
            if (dbgAddr) {
                var addr = this.getAddr(dbgAddr);
                sInfo = '%' + str.toHex(addr) + ": " + (this.bus.getSymbol(addr, true) || sInfo);
            } else {
                var component, componentPrev = null;
                while (component = this.cmp.getComponentByType("Disk", componentPrev)) {
                    var aInfo = component.getSymbolInfo(sAddr);
                    if (aInfo.length) {
                        sInfo = "";
                        for (var i in aInfo) {
                            var a = aInfo[i];
                            if (sInfo) sInfo += '\n';
                            sInfo += a[0] + ": " + a[1] + ' ' + str.toHex(a[2], 4) + ':' + str.toHex(a[3], 4) + " len " + str.toHexWord(a[4]);
                        }
                    }
                    componentPrev = component;
                }
            }
        }
        return sInfo;
    };

    /**
     * dumpMem(asArgs)
     *
     * Dumps page allocations.
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs (asArgs[0] is an optional block address)
     */
    Debugger.prototype.dumpMem = function(asArgs)
    {
        var aBlocks = this.cpu.aMemBlocks;
        if (aBlocks === this.cpu.aBusBlocks) {
            this.println("paging not enabled");
            return;
        }
        this.dumpBlocks(aBlocks, asArgs[0]);
    };

    Debugger.SYSDESCS = {
        0x0100: ["tss286",       false],
        0x0200: ["ldt",          false],
        0x0300: ["busy tss286",  false],
        0x0400: ["call gate",    true],
        0x0500: ["task gate",    true],
        0x0600: ["int gate286",  true],
        0x0700: ["trap gate286", true],
        0x0900: ["tss386",       false],
        0x0B00: ["busy tss386",  false],
        0x0C00: ["call gate386", true],
        0x0E00: ["int gate386",  true],
        0x0F00: ["trap gate386", true]
    };

    /**
     * dumpDesc(asArgs)
     *
     * Dumps a descriptor for the given selector.
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs
     */
    Debugger.prototype.dumpDesc = function(asArgs)
    {
        var sSel = asArgs[0];

        if (!sSel) {
            this.println("no selector");
            return;
        }

        var sel = this.parseValue(sSel);
        if (sel === undefined) {
            this.println("invalid selector: " + sSel);
            return;
        }

        var seg = this.getSegment(sel, Debugger.ADDR.PROT);
        this.println("dumpDesc(" + str.toHexWord(seg? seg.sel : sel) + "): %" + str.toHex(seg? seg.addrDesc : null, this.cchAddr));
        if (!seg) return;

        var sType;
        var fGate = false;
        if (seg.type & X86.DESC.ACC.TYPE.SEG) {
            if (seg.type & X86.DESC.ACC.TYPE.CODE) {
                sType = "code";
                sType += (seg.type & X86.DESC.ACC.TYPE.READABLE)? ",readable" : ",execonly";
                if (seg.type & X86.DESC.ACC.TYPE.CONFORMING) sType += ",conforming";
            }
            else {
                sType = "data";
                sType += (seg.type & X86.DESC.ACC.TYPE.WRITABLE)? ",writable" : ",readonly";
                if (seg.type & X86.DESC.ACC.TYPE.EXPDOWN) sType += ",expdown";
            }
            if (seg.type & X86.DESC.ACC.TYPE.ACCESSED) sType += ",accessed";
        }
        else {
            var sysDesc = Debugger.SYSDESCS[seg.type];
            if (sysDesc) {
                sType = sysDesc[0];
                fGate = sysDesc[1];
            }
        }

        if (sType && !(seg.acc & X86.DESC.ACC.PRESENT)) sType += ",not present";

        var sDump;
        if (fGate) {
            sDump = "seg=" + str.toHexWord(seg.base & 0xffff) + " off=" + str.toHexWord(seg.limit);
        } else {
            sDump = "base=" + str.toHex(seg.base, this.cchAddr) + " limit=" + this.getLimitString(seg.limit);
        }
        /*
         * When we dump the EXT word, we mask off the LIMIT1619 and BASE2431 bits, because those have already
         * been incorporated into the limit and base properties of the segment register; all we care about here
         * are whether EXT contains any of the AVAIL (0x10), BIG (0x40) or LIMITPAGES (0x80) bits.
         */
        this.println(sDump + " type=" + str.toHexByte(seg.type >> 8) + " (" + sType + ')' + " ext=" + str.toHexWord(seg.ext & ~(X86.DESC.EXT.LIMIT1619 | X86.DESC.EXT.BASE2431)) + " dpl=" + str.toHexByte(seg.dpl));
    };

    /**
     * dumpHistory(sPrev, sLines)
     *
     * If sLines is not a number, it can be a instruction filter.  However, for the moment, the only
     * supported filter is "call", which filters the history buffer for all CALL and RET instructions
     * from the specified previous point forward.
     *
     * @this {Debugger}
     * @param {string} [sPrev] is a (decimal) number of instructions to rewind to (default is 10)
     * @param {string} [sLines] is a (decimal) number of instructions to print (default is, again, 10)
     */
    Debugger.prototype.dumpHistory = function(sPrev, sLines)
    {
        var sMore = "";
        var cHistory = 0;
        var iHistory = this.iOpcodeHistory;
        var aHistory = this.aOpcodeHistory;

        if (aHistory.length) {
            var nPrev = +sPrev || this.nextHistory;
            var nLines = +sLines || 10;

            if (isNaN(nPrev)) {
                nPrev = nLines;
            } else {
                sMore = "more ";
            }

            if (nPrev > aHistory.length) {
                this.println("note: only " + aHistory.length + " available");
                nPrev = aHistory.length;
            }

            iHistory -= nPrev;
            if (iHistory < 0) {
                /*
                 * If the dbgAddr of the last aHistory element contains a valid selector, wrap around.
                 */
                if (aHistory[aHistory.length - 1].sel == null) {
                    nPrev = iHistory + nPrev;
                    iHistory = 0;
                } else {
                    iHistory += aHistory.length;
                }
            }

            var aFilters = [];
            if (sLines == "call") {
                nLines = 100000;
                aFilters = ["CALL"];
            }

            if (sPrev !== undefined) {
                this.println(nPrev + " instructions earlier:");
            }

            /*
             * TODO: The following is necessary to prevent dumpHistory() from causing additional (or worse, recursive)
             * faults due to segmented addresses that are no longer valid, but the only alternative is to dramatically
             * increase the amount of memory used to store instruction history (eg, storing copies of all the instruction
             * bytes alongside the execution addresses).
             *
             * For now, we're living dangerously, so that our history dumps actually work.
             *
             *      this.nSuppressBreaks++;
             *
             * If you re-enable this protection, be sure to re-enable the decrement below, too.
             */
            while (nLines > 0 && iHistory != this.iOpcodeHistory) {

                var dbgAddr = aHistory[iHistory++];
                if (dbgAddr.sel == null) break;

                /*
                 * We must create a new dbgAddr from the address in aHistory, because dbgAddr was
                 * a reference, not a copy, and we don't want getInstruction() modifying the original.
                 */
                dbgAddr = this.newAddr(dbgAddr.off, dbgAddr.sel, dbgAddr.addr, dbgAddr.type, dbgAddr.fData32, dbgAddr.fAddr32);

                var sInstruction = this.getInstruction(dbgAddr, "history", nPrev--);
                if (!aFilters.length || sInstruction.indexOf(aFilters[0]) >= 0) {
                    this.println(sInstruction);
                }

                /*
                 * If there were OPERAND or ADDRESS overrides on the previous instruction, getInstruction()
                 * will have automatically disassembled additional bytes, so skip additional history entries.
                 */
                if (dbgAddr.cOverrides) {
                    iHistory += dbgAddr.cOverrides; nLines -= dbgAddr.cOverrides; nPrev -= dbgAddr.cOverrides;
                }

                if (iHistory >= aHistory.length) iHistory = 0;
                this.nextHistory = nPrev;
                cHistory++;
                nLines--;
            }
            /*
             * See comments above.
             *
             *      this.nSuppressBreaks--;
             */
        }

        if (!cHistory) {
            this.println("no " + sMore + "history available");
            this.nextHistory = undefined;
        }
    };

    /*
     * TSS field names and offsets used by dumpTSS()
     */
    Debugger.TSS286 = {
        "PREV_TSS":     0x00,
        "CPL0_SP":      0x02,
        "CPL0_SS":      0x04,
        "CPL1_SP":      0x06,
        "CPL1_SS":      0x08,
        "CPL2_SP":      0x0a,
        "CPL2_SS":      0x0c,
        "TASK_IP":      0x0e,
        "TASK_PS":      0x10,
        "TASK_AX":      0x12,
        "TASK_CX":      0x14,
        "TASK_DX":      0x16,
        "TASK_BX":      0x18,
        "TASK_SP":      0x1a,
        "TASK_BP":      0x1c,
        "TASK_SI":      0x1e,
        "TASK_DI":      0x20,
        "TASK_ES":      0x22,
        "TASK_CS":      0x24,
        "TASK_SS":      0x26,
        "TASK_DS":      0x28,
        "TASK_LDT":     0x2a
    };
    Debugger.TSS386 = {
        "PREV_TSS":     0x00,
        "CPL0_ESP":     0x04,
        "CPL0_SS":      0x08,
        "CPL1_ESP":     0x0c,
        "CPL1_SS":      0x10,
        "CPL2_ESP":     0x14,
        "CPL2_SS":      0x18,
        "TASK_CR3":     0x1C,
        "TASK_EIP":     0x20,
        "TASK_PS":      0x24,
        "TASK_EAX":     0x28,
        "TASK_ECX":     0x2C,
        "TASK_EDX":     0x30,
        "TASK_EBX":     0x34,
        "TASK_ESP":     0x38,
        "TASK_EBP":     0x3C,
        "TASK_ESI":     0x40,
        "TASK_EDI":     0x44,
        "TASK_ES":      0x48,
        "TASK_CS":      0x4C,
        "TASK_SS":      0x50,
        "TASK_DS":      0x54,
        "TASK_FS":      0x58,
        "TASK_GS":      0x5C,
        "TASK_LDT":     0x60,
        "TASK_IOPM":    0x64
    };

    /**
     * dumpTSS(asArgs)
     *
     * This dumps a TSS using the given selector.  If none is specified, the current TR is used.
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs
     */
    Debugger.prototype.dumpTSS = function(asArgs)
    {
        var seg;
        var sSel = asArgs[0];

        if (!sSel) {
            seg = this.cpu.segTSS;
        } else {
            var sel = this.parseValue(sSel);
            if (sel === undefined) {
                this.println("invalid task selector: " + sSel);
                return;
            }
            seg = this.getSegment(sel, Debugger.ADDR.PROT);
        }

        this.println("dumpTSS(" + str.toHexWord(seg? seg.sel : sel) + "): %" + str.toHex(seg? seg.base : null, this.cchAddr));
        if (!seg) return;

        var sDump = "";
        var type = seg.type & ~X86.DESC.ACC.TSS_BUSY;
        var cch = (type == X86.DESC.ACC.TYPE.TSS286? 4 : 8);
        var aTSSFields = (type == X86.DESC.ACC.TYPE.TSS286? Debugger.TSS286 : Debugger.TSS386);
        var off, addr, v;
        for (var sField in aTSSFields) {
            off = aTSSFields[sField];
            addr = seg.base + off;
            v = this.cpu.probeAddr(addr) | (this.cpu.probeAddr(addr + 1) << 8);
            if (type == X86.DESC.ACC.TYPE.TSS386) {
                v |= (this.cpu.probeAddr(addr + 2) << 16) | (this.cpu.probeAddr(addr + 3) << 24);
            }
            if (sDump) sDump += '\n';
            sDump += str.toHexWord(off) + ' ' + str.pad(sField + ':', 11) + str.toHex(v, cch);
        }
        if (type == X86.DESC.ACC.TYPE.TSS386) {
            var iPort = 0;
            off = (v >>> 16);
            /*
             * We arbitrarily cut the IOPM dump off at port 0x3FF; we're not currently interested in anything above that.
             */
            while (off < seg.offMax && iPort < 0x3ff) {
                addr = seg.base + off;
                v = this.cpu.probeAddr(addr) | (this.cpu.probeAddr(addr + 1) << 8);
                sDump += "\n" + str.toHexWord(off) + " ports " + str.toHexWord(iPort) + '-' + str.toHexWord(iPort+15) + ": " + str.toBinBytes(v, 2);
                iPort += 16;
                off += 2;
            }
        }
        this.println(sDump);
    };

    /**
     * messageInit(sEnable)
     *
     * @this {Debugger}
     * @param {string|undefined} sEnable contains zero or more message categories to enable, separated by '|'
     */
    Debugger.prototype.messageInit = function(sEnable)
    {
        this.dbg = this;
        this.bitsMessage = this.bitsWarning = Messages.WARN;
        this.sMessagePrev = null;
        this.afnDumpers = [];
        /*
         * Internally, we use "key" instead of "keys", since the latter is a method on JavasScript objects,
         * but externally, we allow the user to specify "keys"; "kbd" is also allowed as shorthand for "keyboard".
         */
        var aEnable = this.parseCommand(sEnable.replace("keys","key").replace("kbd","keyboard"), false, '|');
        if (aEnable.length) {
            for (var m in Debugger.MESSAGES) {
                if (usr.indexOf(aEnable, m) >= 0) {
                    this.bitsMessage |= Debugger.MESSAGES[m];
                    this.println(m + " messages enabled");
                }
            }
        }
        this.historyInit();     // call this just in case Messages.INT was turned on
    };

    /**
     * messageDump(bitMessage, fnDumper)
     *
     * @this {Debugger}
     * @param {number} bitMessage is one Messages category flag
     * @param {function(Array.<string>)} fnDumper is a function the Debugger can use to dump data for that category
     * @return {boolean} true if successfully registered, false if not
     */
    Debugger.prototype.messageDump = function(bitMessage, fnDumper)
    {
        for (var m in Debugger.MESSAGES) {
            if (bitMessage == Debugger.MESSAGES[m]) {
                this.afnDumpers[m] = fnDumper;
                return true;
            }
        }
        return false;
    };

    /**
     * getRegIndex(sReg, off)
     *
     * @this {Debugger}
     * @param {string} sReg
     * @param {number} [off] optional offset into sReg
     * @return {number} register index, or -1 if not found
     */
    Debugger.prototype.getRegIndex = function(sReg, off) {
        var i;
        sReg = sReg.toUpperCase();
        if (off == null) {
            i = usr.indexOf(Debugger.REGS, sReg);
        } else {
            i = usr.indexOf(Debugger.REGS, sReg.substr(off, 3));
            if (i < 0) i = usr.indexOf(Debugger.REGS, sReg.substr(off, 2));
        }
        return i;
    };

    /**
     * getRegString(iReg)
     *
     * @this {Debugger}
     * @param {number} iReg
     * @return {string}
     */
    Debugger.prototype.getRegString = function(iReg) {
        var cch = 0;
        var n = this.getRegValue(iReg);
        if (n !== undefined) {
            switch(iReg) {
            case Debugger.REG_AL:
            case Debugger.REG_CL:
            case Debugger.REG_DL:
            case Debugger.REG_BL:
            case Debugger.REG_AH:
            case Debugger.REG_CH:
            case Debugger.REG_DH:
            case Debugger.REG_BH:
                cch = 2;
                break;
            case Debugger.REG_AX:
            case Debugger.REG_CX:
            case Debugger.REG_DX:
            case Debugger.REG_BX:
            case Debugger.REG_SP:
            case Debugger.REG_BP:
            case Debugger.REG_SI:
            case Debugger.REG_DI:
            case Debugger.REG_IP:
            case Debugger.REG_SEG + Debugger.REG_ES:
            case Debugger.REG_SEG + Debugger.REG_CS:
            case Debugger.REG_SEG + Debugger.REG_SS:
            case Debugger.REG_SEG + Debugger.REG_DS:
            case Debugger.REG_SEG + Debugger.REG_FS:
            case Debugger.REG_SEG + Debugger.REG_GS:
                cch = 4;
                break;
            case Debugger.REG_EAX:
            case Debugger.REG_ECX:
            case Debugger.REG_EDX:
            case Debugger.REG_EBX:
            case Debugger.REG_ESP:
            case Debugger.REG_EBP:
            case Debugger.REG_ESI:
            case Debugger.REG_EDI:
            case Debugger.REG_CR0:
            case Debugger.REG_CR1:
            case Debugger.REG_CR2:
            case Debugger.REG_CR3:
            case Debugger.REG_EIP:
                cch = 8;
                break;
            case Debugger.REG_PS:
                cch = this.cchReg;
                break;
            }
        }
        return cch? str.toHex(n, cch) : "??";
    };

    /**
     * getRegValue(iReg)
     *
     * @this {Debugger}
     * @param {number} iReg
     * @return {number|undefined}
     */
    Debugger.prototype.getRegValue = function(iReg) {
        var n;
        if (iReg >= 0) {
            var cpu = this.cpu;
            switch(iReg) {
            case Debugger.REG_AL:
                n = cpu.regEAX & 0xff;
                break;
            case Debugger.REG_CL:
                n = cpu.regECX & 0xff;
                break;
            case Debugger.REG_DL:
                n = cpu.regEDX & 0xff;
                break;
            case Debugger.REG_BL:
                n = cpu.regEBX & 0xff;
                break;
            case Debugger.REG_AH:
                n = (cpu.regEAX >> 8) & 0xff;
                break;
            case Debugger.REG_CH:
                n = (cpu.regECX >> 8) & 0xff;
                break;
            case Debugger.REG_DH:
                n = (cpu.regEDX >> 8) & 0xff;
                break;
            case Debugger.REG_BH:
                n = (cpu.regEBX >> 8) & 0xff;
                break;
            case Debugger.REG_AX:
                n = cpu.regEAX & 0xffff;
                break;
            case Debugger.REG_CX:
                n = cpu.regECX & 0xffff;
                break;
            case Debugger.REG_DX:
                n = cpu.regEDX & 0xffff;
                break;
            case Debugger.REG_BX:
                n = cpu.regEBX & 0xffff;
                break;
            case Debugger.REG_SP:
                n = cpu.getSP() & 0xffff;
                break;
            case Debugger.REG_BP:
                n = cpu.regEBP & 0xffff;
                break;
            case Debugger.REG_SI:
                n = cpu.regESI & 0xffff;
                break;
            case Debugger.REG_DI:
                n = cpu.regEDI & 0xffff;
                break;
            case Debugger.REG_IP:
                n = cpu.getIP() & 0xffff;
                break;
            case Debugger.REG_PS:
                n = cpu.getPS();
                break;
            case Debugger.REG_SEG + Debugger.REG_ES:
                n = cpu.getES();
                break;
            case Debugger.REG_SEG + Debugger.REG_CS:
                n = cpu.getCS();
                break;
            case Debugger.REG_SEG + Debugger.REG_SS:
                n = cpu.getSS();
                break;
            case Debugger.REG_SEG + Debugger.REG_DS:
                n = cpu.getDS();
                break;
            default:
                if (this.cpu.model == X86.MODEL_80286) {
                    if (iReg == Debugger.REG_CR0) {
                        n = cpu.regCR0;
                    }
                }
                else if (I386 && this.cpu.model >= X86.MODEL_80386) {
                    switch(iReg) {
                    case Debugger.REG_EAX:
                        n = cpu.regEAX;
                        break;
                    case Debugger.REG_ECX:
                        n = cpu.regECX;
                        break;
                    case Debugger.REG_EDX:
                        n = cpu.regEDX;
                        break;
                    case Debugger.REG_EBX:
                        n = cpu.regEBX;
                        break;
                    case Debugger.REG_ESP:
                        n = cpu.getSP();
                        break;
                    case Debugger.REG_EBP:
                        n = cpu.regEBP;
                        break;
                    case Debugger.REG_ESI:
                        n = cpu.regESI;
                        break;
                    case Debugger.REG_EDI:
                        n = cpu.regEDI;
                        break;
                    case Debugger.REG_CR0:
                        n = cpu.regCR0;
                        break;
                    case Debugger.REG_CR1:
                        n = cpu.regCR1;
                        break;
                    case Debugger.REG_CR2:
                        n = cpu.regCR2;
                        break;
                    case Debugger.REG_CR3:
                        n = cpu.regCR3;
                        break;
                    case Debugger.REG_SEG + Debugger.REG_FS:
                        n = cpu.getFS();
                        break;
                    case Debugger.REG_SEG + Debugger.REG_GS:
                        n = cpu.getGS();
                        break;
                    case Debugger.REG_EIP:
                        n = cpu.getIP();
                        break;
                    }
                }
                break;
            }
        }
        return n;
    };

    /**
     * replaceRegs(s)
     *
     * @this {Debugger}
     * @param {string} s
     * @return {string}
     */
    Debugger.prototype.replaceRegs = function(s) {
        /*
         * Replace any references first; this means that register references inside the reference
         * do NOT need to be prefixed with '%'.
         */
        s = this.parseReference(s);

        /*
         * Replace every %XX (or %XXX), where XX (or XXX) is a register, with the register's value.
         */
        var i = 0;
        var b, sChar, sAddr, dbgAddr, sReplace;
        while ((i = s.indexOf('%', i)) >= 0) {
            var iReg = this.getRegIndex(s, i + 1);
            if (iReg >= 0) {
                s = s.substr(0, i) + this.getRegString(iReg) + s.substr(i + 1 + Debugger.REGS[iReg].length);
            }
            i++;
        }
        /*
         * Replace every #XX, where XX is a hex byte value, with the corresponding ASCII character (if printable).
         */
        i = 0;
        while ((i = s.indexOf('#', i)) >= 0) {
            sChar = s.substr(i+1, 2);
            b = str.parseInt(sChar, 16);
            if (b != null && b >= 32 && b < 128) {
                sReplace = sChar + " '" + String.fromCharCode(b) + "'";
                s = s.replace('#' + sChar, sReplace);
                i += sReplace.length;
                continue;
            }
            i++;
        }
        /*
         * Replace every $XXXX:XXXX, where XXXX:XXXX is a segmented address, with the zero-terminated string at that address.
         */
        i = 0;
        while ((i = s.indexOf('$', i)) >= 0) {
            sAddr = s.substr(i+1, 9);
            dbgAddr = this.parseAddr(sAddr);
            if (dbgAddr) {
                sReplace = sAddr + ' "' + this.getSZ(dbgAddr) + '"';
                s = s.replace('$' + sAddr, sReplace);
                i += sReplace.length;
            }
        }
        /*
         * Replace every ^XXXX:XXXX, where XXXX:XXXX is a segmented address, with the FCB filename stored at that address.
         */
        i = 0;
        while ((i = s.indexOf('^', i)) >= 0) {
            sAddr = s.substr(i+1, 9);
            dbgAddr = this.parseAddr(sAddr);
            if (dbgAddr) {
                this.incAddr(dbgAddr);
                sReplace = sAddr + ' "' + this.getSZ(dbgAddr, 11) + '"';
                s = s.replace('^' + sAddr, sReplace);
                i += sReplace.length;
            }
        }
        return s;
    };

    /**
     * message(sMessage, fAddress)
     *
     * @this {Debugger}
     * @param {string} sMessage is any caller-defined message string
     * @param {boolean} [fAddress] is true to display the current CS:IP
     */
    Debugger.prototype.message = function(sMessage, fAddress)
    {
        if (fAddress) {
            sMessage += " @" + this.hexOffset(this.cpu.getIP(), this.cpu.getCS()) + " (%" + str.toHex(this.cpu.regLIP) + ")";
        }

        if (this.sMessagePrev && sMessage == this.sMessagePrev) return;

        if (!SAMPLER) this.println(sMessage);   // + " (" + this.cpu.getCycles() + " cycles)"

        this.sMessagePrev = sMessage;

        if (this.cpu) {
            if (this.bitsMessage & Messages.HALT) {
                this.stopCPU();
            }
            /*
             * We have no idea what the frequency of println() calls might be; all we know is that they easily
             * screw up the CPU's careful assumptions about cycles per burst.  So we call yieldCPU() after every
             * message, to effectively end the current burst and start fresh.
             *
             * TODO: See CPU.calcStartTime() for a discussion of why we might want to call yieldCPU() *before*
             * we display the message.
             */
            this.cpu.yieldCPU();
        }
    };

    /**
     * messageInt(nInt, addr, fForce)
     *
     * @this {Debugger}
     * @param {number} nInt
     * @param {number} addr (LIP after the "INT n" instruction has been fetched but not dispatched)
     * @param {boolean} [fForce] (true if the message should be forced)
     * @return {boolean} true if message generated (which in turn triggers addIntReturn() inside checkIntNotify()), false if not
     */
    Debugger.prototype.messageInt = function(nInt, addr, fForce)
    {
        var AH, DL;
        var fMessage = fForce;

        /*
         * We currently arrive here only because the CPU has already determined that INT messages are enabled,
         * or because the ChipSet's RTC interrupt handler has already determined that INT messages are enabled.
         *
         * But software interrupts are very common, so we generally require additional categories to be enabled;
         * unless the caller has set fForce, we check those additional categories now.
         */
        if (!fMessage) {
            /*
             * Display all software interrupts if CPU messages are enabled (and it's not an "annoying" interrupt);
             * note that in some cases, even "annoying" interrupts can be turned with an extra message category.
             */
            fMessage = this.messageEnabled(Messages.CPU) && Debugger.INT_ANNOYING.indexOf(nInt) < 0;
            if (!fMessage) {
                /*
                 * Alternatively, display this software interrupt if its corresponding message category is enabled.
                 */
                var nCategory = Debugger.INT_MESSAGES[nInt];
                if (nCategory) {
                    if (this.messageEnabled(nCategory)) {
                        fMessage = true;
                    } else {
                        /*
                         * Alternatively, display this FDC interrupt if HDC messages are enabled (since they share
                         * a common software interrupt).  Normally, an HDC BIOS will copy the original DISK (0x13)
                         * vector to the ALT_DISK (0x40) vector, but it's a nuisance having to check different
                         * interrupts in different configurations for the same frickin' functionality, so we don't.
                         */
                        fMessage = (nCategory == Messages.FDC && this.messageEnabled(nCategory = Messages.HDC));
                    }
                }
            }
        }
        if (fMessage) {
            AH = (this.cpu.regEAX >> 8) & 0xff;
            DL = this.cpu.regEDX & 0xff;
            if (nInt == Interrupts.DOS /* 0x21 */ && AH == 0x0b ||
                nCategory == Messages.FDC && DL >= 0x80 || nCategory == Messages.HDC && DL < 0x80) {
                fMessage = false;
            }
        }
        if (fMessage) {
            var aFuncs = Interrupts.FUNCS[nInt];
            var sFunc = (aFuncs && aFuncs[AH]) || "";
            if (sFunc) sFunc = ' ' + this.replaceRegs(sFunc);
            /*
             * For display purposes only, rewind addr to the address of the responsible "INT n" instruction;
             * we know it's the two-byte "INT n" instruction because that's the only opcode handler that calls
             * checkIntNotify() at the moment.
             */
            addr -= 2;
            this.message("INT " + str.toHexByte(nInt) + ": AH=" + str.toHexByte(AH) + " @" + this.hexOffset(addr - this.cpu.segCS.base, this.cpu.getCS()) + sFunc);
        }
        return fMessage;
    };

    /**
     * messageIntReturn(nInt, nLevel, nCycles)
     *
     * @this {Debugger}
     * @param {number} nInt
     * @param {number} nLevel
     * @param {number} nCycles
     * @param {string} [sResult]
     */
    Debugger.prototype.messageIntReturn = function(nInt, nLevel, nCycles, sResult)
    {
        this.message("INT " + str.toHexByte(nInt) + ": C=" + (this.cpu.getCF()? 1 : 0) + (sResult || "") + " (cycles=" + nCycles + (nLevel? ",level=" + (nLevel+1) : "") + ')');
    };

    /**
     * messageIO(component, port, bOut, addrFrom, name, bIn, bitsMessage)
     *
     * @this {Debugger}
     * @param {Component} component
     * @param {number} port
     * @param {number|null} bOut if an output operation
     * @param {number|null} [addrFrom]
     * @param {string|null} [name] of the port, if any
     * @param {number|null} [bIn] is the input value, if known, on an input operation
     * @param {number} [bitsMessage] is one or more Messages category flag(s)
     */
    Debugger.prototype.messageIO = function(component, port, bOut, addrFrom, name, bIn, bitsMessage)
    {
        bitsMessage |= Messages.PORT;
        if (addrFrom == null || (this.bitsMessage & bitsMessage) == bitsMessage) {
            var selFrom = null;
            if (addrFrom != null) {
                selFrom = this.cpu.getCS();
                addrFrom -= this.cpu.segCS.base;
            }
            this.message(component.idComponent + '.' + (bOut != null? "outPort" : "inPort") + '(' + str.toHexWord(port) + ',' + (name? name : "unknown") + (bOut != null? ',' + str.toHexByte(bOut) : "") + ')' + (bIn != null? (": " + str.toHexByte(bIn)) : "") + (addrFrom != null? (" @" + this.hexOffset(addrFrom, selFrom)) : ""));
        }
    };

    /**
     * traceInit()
     *
     * @this {Debugger}
     */
    Debugger.prototype.traceInit = function()
    {
        if (DEBUG) {
            this.traceEnabled = {};
            for (var prop in Debugger.TRACE) {
                this.traceEnabled[prop] = false;
            }
            this.iTraceBuffer = 0;
            this.aTraceBuffer = [];     // we now defer TRACE_LIMIT allocation until the first traceLog() call
        }
    };

    /**
     * traceLog(prop, dst, src, flagsIn, flagsOut, resultLo, resultHi)
     *
     * @this {Debugger}
     * @param {string} prop
     * @param {number} dst
     * @param {number} src
     * @param {number|null} flagsIn
     * @param {number|null} flagsOut
     * @param {number} resultLo
     * @param {number} [resultHi]
     */
    Debugger.prototype.traceLog = function(prop, dst, src, flagsIn, flagsOut, resultLo, resultHi)
    {
        if (DEBUG) {
            if (this.traceEnabled !== undefined && this.traceEnabled[prop]) {
                var trace = Debugger.TRACE[prop];
                var len = (trace.size >> 2);
                var s = this.hexOffset(this.cpu.opLIP - this.cpu.segCS.base, this.cpu.getCS()) + ' ' + Debugger.INS_NAMES[trace.ins] + '(' + str.toHex(dst, len) + ',' + str.toHex(src, len) + ',' + (flagsIn === null? '-' : str.toHexWord(flagsIn)) + ") " + str.toHex(resultLo, len) + ',' + (flagsOut === null? '-' : str.toHexWord(flagsOut));
                if (!this.aTraceBuffer.length) this.aTraceBuffer = new Array(Debugger.TRACE_LIMIT);
                this.aTraceBuffer[this.iTraceBuffer++] = s;
                if (this.iTraceBuffer >= this.aTraceBuffer.length) {
                    /*
                     * Instead of wrapping the buffer, we're going to turn all tracing off.
                     *
                     *      this.iTraceBuffer = 0;
                     */
                    for (prop in this.traceEnabled) {
                        this.traceEnabled[prop] = false;
                    }
                    this.println("trace buffer full");
                }
            }
        }
    };

    /**
     * init()
     *
     * @this {Debugger}
     */
    Debugger.prototype.init = function()
    {
        this.println("Type ? for list of debugger commands");
        this.updateStatus();
        if (this.sInitCommands) {
            var a = this.parseCommand(this.sInitCommands);
            this.sInitCommands = null;
            for (var s in a) this.doCommand(a[s]);
        }
    };

    /**
     * historyInit()
     *
     * This function is intended to be called by the constructor, reset(), addBreakpoint(), findBreakpoint()
     * and any other function that changes the checksEnabled() criteria used to decide whether checkInstruction()
     * should be called.
     *
     * That is, if the history arrays need to be allocated and haven't already been allocated, then allocate them,
     * and if the arrays are no longer needed, then deallocate them.
     *
     * @this {Debugger}
     */
    Debugger.prototype.historyInit = function()
    {
        var i;
        if (!this.checksEnabled()) {
            if (this.aOpcodeHistory && this.aOpcodeHistory.length) this.println("instruction history buffer freed");
            this.iOpcodeHistory = 0;
            this.aOpcodeHistory = [];
            this.aaOpcodeCounts = [];
            return;
        }
        if (!this.aOpcodeHistory || !this.aOpcodeHistory.length) {
            this.aOpcodeHistory = new Array(Debugger.HISTORY_LIMIT);
            for (i = 0; i < this.aOpcodeHistory.length; i++) {
                /*
                 * Preallocate dummy Addr (Array) objects in every history slot, so that
                 * checkInstruction() doesn't need to call newAddr() on every slot update.
                 */
                this.aOpcodeHistory[i] = this.newAddr();
            }
            this.iOpcodeHistory = 0;
            this.println("instruction history buffer allocated");
        }
        if (!this.aaOpcodeCounts || !this.aaOpcodeCounts.length) {
            this.aaOpcodeCounts = new Array(256);
            for (i = 0; i < this.aaOpcodeCounts.length; i++) {
                this.aaOpcodeCounts[i] = [i, 0];
            }
        }
    };

    /**
     * runCPU(fOnClick)
     *
     * @this {Debugger}
     * @param {boolean} [fOnClick] is true if called from a click handler that might have stolen focus
     * @return {boolean} true if run request successful, false if not
     */
    Debugger.prototype.runCPU = function(fOnClick)
    {
        if (!this.isCPUAvail()) return false;
        this.cpu.runCPU(fOnClick);
        return true;
    };

    /**
     * stepCPU(nCycles, fRegs, fUpdateCPU)
     *
     * @this {Debugger}
     * @param {number} nCycles (0 for one instruction without checking breakpoints)
     * @param {boolean} [fRegs] is true to display registers after step (default is false)
     * @param {boolean} [fUpdateCPU] is false to disable calls to updateCPU() (default is true)
     * @return {boolean}
     */
    Debugger.prototype.stepCPU = function(nCycles, fRegs, fUpdateCPU)
    {
        if (!this.isCPUAvail()) return false;

        this.nCycles = 0;
        do {
            if (!nCycles) {
                /*
                 * When single-stepping, the CPU won't call checkInstruction(), which is good for
                 * avoiding breakpoints, but bad for instruction data collection if checks are enabled.
                 * So we call checkInstruction() ourselves.
                 */
                if (this.checksEnabled()) this.checkInstruction(this.cpu.regLIP, 0);
            }
            try {
                var nCyclesStep = this.cpu.stepCPU(nCycles);
                if (nCyclesStep > 0) {
                    this.nCycles += nCyclesStep;
                    this.cpu.addCycles(nCyclesStep, true);
                    this.cpu.updateChecksum(nCyclesStep);
                    this.cOpcodes++;
                }
            }
            catch (e) {
                this.nCycles = 0;
                this.cpu.setError(e.stack || e.message);
            }
        } while (this.cpu.opFlags & X86.OPFLAG_PREFIXES);

        /*
         * Because we called cpu.stepCPU() and not cpu.runCPU(), we must nudge the cpu's update code,
         * and then update our own state.  Normally, the only time fUpdateCPU will be false is when doTrace()
         * is calling us in a loop, in which case it will perform its own updateCPU() when it's done.
         */
        if (fUpdateCPU !== false) this.cpu.updateCPU();

        this.updateStatus(fRegs || false);
        return (this.nCycles > 0);
    };

    /**
     * stopCPU()
     *
     * @this {Debugger}
     * @param {boolean} [fComplete]
     */
    Debugger.prototype.stopCPU = function(fComplete)
    {
        if (this.cpu) this.cpu.stopCPU(fComplete);
    };

    /**
     * updateStatus(fRegs)
     *
     * @this {Debugger}
     * @param {boolean} [fRegs] (default is true)
     */
    Debugger.prototype.updateStatus = function(fRegs)
    {
        if (fRegs === undefined) fRegs = true;

        this.dbgAddrNextCode = this.newAddr(this.cpu.getIP(), this.cpu.getCS());
        /*
         * this.nStep used to be a simple boolean, but now it's 0 (or undefined)
         * if inactive, 1 if stepping over an instruction without a register dump, or 2
         * if stepping over an instruction with a register dump.
         */
        if (!fRegs || this.nStep == 1)
            this.doUnassemble();
        else {
            this.doRegisters();
        }
    };

    /**
     * isCPUAvail()
     *
     * Make sure the CPU is ready (finished initializing), not busy (already running), and not in an error state.
     *
     * @this {Debugger}
     * @return {boolean}
     */
    Debugger.prototype.isCPUAvail = function()
    {
        if (!this.cpu)
            return false;
        if (!this.cpu.isReady())
            return false;
        if (!this.cpu.isPowered())
            return false;
        if (this.cpu.isBusy())
            return false;
        return !this.cpu.isError();
    };

    /**
     * powerUp(data, fRepower)
     *
     * @this {Debugger}
     * @param {Object|null} data
     * @param {boolean} [fRepower]
     * @return {boolean} true if successful, false if failure
     */
    Debugger.prototype.powerUp = function(data, fRepower)
    {
        if (!fRepower) {
            /*
             * Because Debugger save/restore support is somewhat limited (and didn't always exist),
             * we deviate from the typical save/restore design pattern: instead of reset OR restore,
             * we always reset and then perform a (potentially limited) restore.
             */
            this.reset(true);

            // this.println(data? "resuming" : "powering up");

            if (data && this.restore) {
                if (!this.restore(data)) return false;
            }
        }
        return true;
    };

    /**
     * powerDown(fSave, fShutdown)
     *
     * @this {Debugger}
     * @param {boolean} [fSave]
     * @param {boolean} [fShutdown]
     * @return {Object|boolean}
     */
    Debugger.prototype.powerDown = function(fSave, fShutdown)
    {
        if (fShutdown) this.println(fSave? "suspending" : "shutting down");
        return fSave && this.save? this.save() : true;
    };

    /**
     * reset(fQuiet)
     *
     * This is a notification handler, called by the Computer, to inform us of a reset.
     *
     * @this {Debugger}
     * @param {boolean} fQuiet (true only when called from our own powerUp handler)
     */
    Debugger.prototype.reset = function(fQuiet)
    {
        this.historyInit();
        this.cOpcodes = 0;
        this.sMessagePrev = null;
        this.nCycles = 0;
        this.dbgAddrNextCode = this.newAddr(this.cpu.getIP(), this.cpu.getCS());
        /*
         * fRunning is set by start() and cleared by stop().  In addition, we clear
         * it here, so that if the CPU is reset while running, we can prevent stop()
         * from unnecessarily dumping the CPU state.
         */
        this.aFlags.fRunning = false;
        this.clearTempBreakpoint();
        if (!fQuiet) this.updateStatus();
    };

    /**
     * save()
     *
     * This implements (very rudimentary) save support for the Debugger component.
     *
     * @this {Debugger}
     * @return {Object}
     */
    Debugger.prototype.save = function()
    {
        var state = new State(this);
        state.set(0, this.packAddr(this.dbgAddrNextCode));
        state.set(1, this.packAddr(this.dbgAddrAssemble));
        state.set(2, [this.aPrevCmds, this.fAssemble, this.bitsMessage]);
        return state.data();
    };

    /**
     * restore(data)
     *
     * This implements (very rudimentary) restore support for the Debugger component.
     *
     * @this {Debugger}
     * @param {Object} data
     * @return {boolean} true if successful, false if failure
     */
    Debugger.prototype.restore = function(data)
    {
        var i = 0;
        if (data[2] !== undefined) {
            this.dbgAddrNextCode = this.unpackAddr(data[i++]);
            this.dbgAddrAssemble = this.unpackAddr(data[i++]);
            this.aPrevCmds = data[i][0];
            if (typeof this.aPrevCmds == "string") this.aPrevCmds = [this.aPrevCmds];
            this.fAssemble = data[i][1];
            this.bitsMessage |= data[i][2];     // keep our current message bits set, and simply "add" any extra bits defined by the saved state
        }
        return true;
    };

    /**
     * start(ms, nCycles)
     *
     * This is a notification handler, called by the Computer, to inform us the CPU has started.
     *
     * @this {Debugger}
     * @param {number} ms
     * @param {number} nCycles
     */
    Debugger.prototype.start = function(ms, nCycles)
    {
        if (!this.nStep) this.println("running");
        this.aFlags.fRunning = true;
        this.msStart = ms;
        this.nCyclesStart = nCycles;
    };

    /**
     * stop(ms, nCycles)
     *
     * This is a notification handler, called by the Computer, to inform us the CPU has now stopped.
     *
     * @this {Debugger}
     * @param {number} ms
     * @param {number} nCycles
     */
    Debugger.prototype.stop = function(ms, nCycles)
    {
        if (this.aFlags.fRunning) {
            this.aFlags.fRunning = false;
            this.nCycles = nCycles - this.nCyclesStart;
            if (!this.nStep) {
                var sStopped = "stopped";
                if (this.nCycles) {
                    var msTotal = ms - this.msStart;
                    var nCyclesPerSecond = (msTotal > 0? Math.round(this.nCycles * 1000 / msTotal) : 0);
                    sStopped += " (";
                    if (this.checksEnabled()) {
                        sStopped += this.cOpcodes + " opcodes, ";
                        this.cOpcodes = 0;      // remove this line if you want to maintain a longer total
                    }
                    sStopped += this.nCycles + " cycles, " + msTotal + " ms, " + nCyclesPerSecond + " hz)";
                    if (MAXDEBUG && this.chipset) {
                        var i, c, n;
                        for (i = 0; i < this.chipset.acInterrupts.length; i++) {
                            c = this.chipset.acInterrupts[i];
                            if (!c) continue;
                            n = c / Math.round(msTotal / 1000);
                            this.println("IRQ" + i + ": " + c + " interrupts (" + n + " per sec)");
                            this.chipset.acInterrupts[i] = 0;
                        }
                        for (i = 0; i < this.chipset.acTimersFired.length; i++) {
                            c = this.chipset.acTimersFired[i];
                            if (!c) continue;
                            n = c / Math.round(msTotal / 1000);
                            this.println("TIMER" + i + ": " + c + " fires (" + n + " per sec)");
                            this.chipset.acTimersFired[i] = 0;
                        }
                        n = 0;
                        for (i = 0; i < this.chipset.acTimer0Counts.length; i++) {
                            var a = this.chipset.acTimer0Counts[i];
                            n += a[0];
                            this.println("TIMER0 update #" + i + ": [" + a[0] + ',' + a[1] + ',' + a[2] + ']');
                        }
                        this.chipset.acTimer0Counts = [];
                    }
                }
                this.println(sStopped);
            }
            this.updateStatus(true);
            this.setFocus();
            this.clearTempBreakpoint(this.cpu.regLIP);
        }
    };

    /**
     * checksEnabled(fRelease)
     *
     * This "check" function is called by the CPU; we indicate whether or not every instruction needs to be checked.
     *
     * Originally, this returned true even when there were only read and/or write breakpoints, but those breakpoints
     * no longer require the intervention of checkInstruction(); the Bus component automatically swaps in/out appropriate
     * "checked" Memory access functions to deal with those breakpoints in the corresponding Memory blocks.  So I've
     * simplified the test below.
     *
     * @this {Debugger}
     * @param {boolean} [fRelease] is true for release criteria only; default is false (any criteria)
     * @return {boolean} true if every instruction needs to pass through checkInstruction(), false if not
     */
    Debugger.prototype.checksEnabled = function(fRelease)
    {
        return ((DEBUG && !fRelease)? true : (this.aBreakExec.length > 1 || this.messageEnabled(Messages.INT) /* || this.aBreakRead.length > 1 || this.aBreakWrite.length > 1 */));
    };

    /**
     * checkInstruction(addr, nState)
     *
     * This "check" function is called by the CPU to inform us about the next instruction to be executed,
     * giving us an opportunity to look for "exec" breakpoints and update opcode frequencies and instruction history.
     *
     * @this {Debugger}
     * @param {number} addr
     * @param {number} nState is < 0 if stepping, 0 if starting, or > 0 if running
     * @return {boolean} true if breakpoint hit, false if not
     */
    Debugger.prototype.checkInstruction = function(addr, nState)
    {
        if (nState > 0) {
            if (this.checkBreakpoint(addr, 1, this.aBreakExec)) {
                return true;
            }
            /*
             * Halt if running with interrupts disabled and IOPL < CPL, because that's likely an error
             */
            if (MAXDEBUG && !(this.cpu.regPS & X86.PS.IF) && this.cpu.nIOPL < this.cpu.nCPL) {
                this.printMessage("interrupts disabled at IOPL " + this.cpu.nIOPL + " and CPL " + this.cpu.nCPL, true);
                return true;
            }
        }

        /*
         * The rest of the instruction tracking logic can only be performed if historyInit() has allocated the
         * necessary data structures.  Note that there is no explicit UI for enabling/disabling history, other than
         * adding/removing breakpoints, simply because it's breakpoints that trigger the call to checkInstruction();
         * well, OK, and a few other things now, like enabling Messages.INT messages.
         */
        if (nState >= 0 && this.aaOpcodeCounts.length) {
            this.cOpcodes++;
            var bOpcode = this.cpu.probeAddr(addr);
            if (bOpcode != null) {
                this.aaOpcodeCounts[bOpcode][1]++;
                var dbgAddr = this.aOpcodeHistory[this.iOpcodeHistory];
                this.setAddr(dbgAddr, this.cpu.getIP(), this.cpu.getCS());
                if (++this.iOpcodeHistory == this.aOpcodeHistory.length) this.iOpcodeHistory = 0;
            }
        }
        return false;
    };

    /**
     * checkMemoryRead(addr, nb)
     *
     * This "check" function is called by a Memory block to inform us that a memory read occurred, giving us an
     * opportunity to track the read if we want, and look for a matching "read" breakpoint, if any.
     *
     * In the "old days", it would be an error for this call to fail to find a matching Debugger breakpoint, but now
     * Memory blocks have no idea whether the Debugger or the machine's Debug register(s) triggered this "checked" read.
     *
     * If we return true, we "trump" the machine's Debug register(s); false allows normal Debug register processing.
     *
     * @this {Debugger}
     * @param {number} addr
     * @param {number} [nb] (# of bytes; default is 1)
     * @return {boolean} true if breakpoint hit, false if not
     */
    Debugger.prototype.checkMemoryRead = function(addr, nb)
    {
        if (this.checkBreakpoint(addr, nb || 1, this.aBreakRead)) {
            this.stopCPU(true);
            return true;
        }
        return false;
    };

    /**
     * checkMemoryWrite(addr, nb)
     *
     * This "check" function is called by a Memory block to inform us that a memory write occurred, giving us an
     * opportunity to track the write if we want, and look for a matching "write" breakpoint, if any.
     *
     * In the "old days", it would be an error for this call to fail to find a matching Debugger breakpoint, but now
     * Memory blocks have no idea whether the Debugger or the machine's Debug register(s) triggered this "checked" write.
     *
     * If we return true, we "trump" the machine's Debug register(s); false allows normal Debug register processing.
     *
     * @this {Debugger}
     * @param {number} addr
     * @param {number} [nb] (# of bytes; default is 1)
     * @return {boolean} true if breakpoint hit, false if not
     */
    Debugger.prototype.checkMemoryWrite = function(addr, nb)
    {
        if (this.checkBreakpoint(addr, nb || 1, this.aBreakWrite)) {
            this.stopCPU(true);
            return true;
        }
        return false;
    };

    /**
     * checkPortInput(port, bIn)
     *
     * This "check" function is called by the Bus component to inform us that port input occurred.
     *
     * @this {Debugger}
     * @param {number} port
     * @param {number} bIn
     * @return {boolean} true if breakpoint hit, false if not
     */
    Debugger.prototype.checkPortInput = function(port, bIn)
    {
        /*
         * We trust that the Bus component won't call us unless we told it to, so we halt unconditionally
         */
        this.println("break on input from port " + str.toHexWord(port) + ": " + str.toHexByte(bIn));
        this.stopCPU(true);
        return true;
    };

    /**
     * checkPortOutput(port, bOut)
     *
     * This "check" function is called by the Bus component to inform us that port output occurred.
     *
     * @this {Debugger}
     * @param {number} port
     * @param {number} bOut
     * @return {boolean} true if breakpoint hit, false if not
     */
    Debugger.prototype.checkPortOutput = function(port, bOut)
    {
        /*
         * We trust that the Bus component won't call us unless we told it to, so we halt unconditionally
         */
        this.println("break on output to port " + str.toHexWord(port) + ": " + str.toHexByte(bOut));
        this.stopCPU(true);
        return true;
    };

    /**
     * clearBreakpoints()
     *
     * @this {Debugger}
     */
    Debugger.prototype.clearBreakpoints = function()
    {
        var i;
        this.aBreakExec = ["exec"];
        if (this.aBreakRead !== undefined) {
            for (i = 1; i < this.aBreakRead.length; i++) {
                this.bus.removeMemBreak(this.getAddr(this.aBreakRead[i]), false);
            }
        }
        this.aBreakRead = ["read"];
        if (this.aBreakWrite !== undefined) {
            for (i = 1; i < this.aBreakWrite.length; i++) {
                this.bus.removeMemBreak(this.getAddr(this.aBreakWrite[i]), true);
            }
        }
        this.aBreakWrite = ["write"];
        /*
         * nSuppressBreaks ensures we can't get into an infinite loop where a breakpoint lookup requires
         * reading a segment descriptor via getSegment(), and that triggers more memory reads, which triggers
         * more breakpoint checks.
         */
        this.nSuppressBreaks = 0;
    };

    /**
     * addBreakpoint(aBreak, dbgAddr, fTempBreak)
     *
     * In case you haven't already figured this out, all our breakpoint commands use the address
     * to identify a breakpoint, not an incrementally assigned breakpoint index like other debuggers;
     * see doBreak() for details.
     *
     * This has a few implications, one being that you CANNOT set more than one kind of breakpoint
     * on a single address.  In practice, that's rarely a problem, because you can almost always set
     * a different breakpoint on a neighboring address.
     *
     * Also, there is one exception to the "one address, one breakpoint" rule, and that involves
     * temporary breakpoints (ie, one-time execution breakpoints that either a "p" or "g" command
     * may create to step over a chunk of code).  Those breakpoints automatically clear themselves,
     * so there usually isn't any need to refer to them using breakpoint commands.
     *
     * TODO: Consider supporting the more "traditional" breakpoint index syntax; the current
     * address-based syntax was implemented solely for expediency and consistency.  At the same time,
     * also consider a more WDEB386-like syntax, where "br" is used to set a variety of access-specific
     * breakpoints, using modifiers like "r1", "r2", "w1", "w2, etc.
     *
     * Here's an example of our powerful new breakpoint command capabilities:
     *
     *      bp 0397:022B "?'GlobalAlloc(wFlags:[ss:sp+8],dwBytes:[ss:sp+6][ss:sp+4])';g [ss:sp+2]:[ss:sp] '?ax;if ax'"
     *
     * The above breakpoint will display a pleasing "GlobalAlloc()" string containing the current
     * stack parameters, and will briefly stop execution on the return to print the result in AX,
     * halting the CPU whenever AX is zero (the default behavior of "if" whenever the expression is
     * false is to look for an "else" and automatically halt when there is no "else").
     *
     * How do you figure out where the code for GlobalAlloc is in the first place?  You need to have
     * BACKTRACK support enabled (which currently means running the non-COMPILED version), so that as
     * the Disk component loads disk images, it will automatically extract symbolic information from all
     * "NE" (New Executable) binaries on those disks, which the Debugger's "di" command can then search
     * for you; eg:
     *
     *      ## di globalalloc
     *      GLOBALALLOC: KRNL386.EXE 0001:022B len 0xC570
     *
     * And then you just need to do a bit more sleuthing to find the right CODE segment.  And that just
     * got easier, now that the PCjs Debugger mimics portions of the Windows Debugger INT 0x41 interface;
     * see intWindowsDebugger() for details.  So even if you neglect to run WDEB386.EXE /E inside the
     * machine before running Windows, you should still see notifications like:
     *
     *      KERNEL!undefined code(0001)=#0397 len 0000C580
     *
     * in the PCjs Debugger output window, as segments are being loaded by the Windows kernel.
     *
     * @this {Debugger}
     * @param {Array} aBreak
     * @param {DbgAddr} dbgAddr
     * @param {boolean} [fTempBreak]
     * @return {boolean} true if breakpoint added, false if already exists
     */
    Debugger.prototype.addBreakpoint = function(aBreak, dbgAddr, fTempBreak)
    {
        var fSuccess = true;

        // this.nSuppressBreaks++;

        /*
         * Instead of complaining that a breakpoint already exists (as we used to do), we now
         * allow breakpoints to be re-set; this makes it easier to update any commands that may
         * be associated with the breakpoint.
         *
         * The only exception: we DO allow a temporary breakpoint at an address where there may
         * already be a breakpoint, so that you can easily step ("p" or "g") over such addresses.
         */
        if (!fTempBreak) {
            this.findBreakpoint(aBreak, dbgAddr, true, false, true);
        }

        if (aBreak != this.aBreakExec) {
            var addr = this.getAddr(dbgAddr);
            if (addr == X86.ADDR_INVALID) {
                this.println("invalid address: " + this.hexAddr(dbgAddr));
                fSuccess = false;
            } else {
                this.bus.addMemBreak(addr, aBreak == this.aBreakWrite);
                /*
                 * Force memory breakpoints to use their linear address, by zapping the selector.
                 */
                dbgAddr.sel = null;
            }
        }

        if (fSuccess) {
            aBreak.push(dbgAddr);
            if (fTempBreak) {
                /*
                 * Force temporary breakpoints to use their linear address, if one is available, by zapping
                 * the selector; this allows us to step over calls or interrupts that change the processor mode.
                 *
                 * TODO: Unfortunately, this will fail to "step" over a call in segment that moves during the call;
                 * consider alternatives.
                 */
                if (dbgAddr.addr != null) dbgAddr.sel = null;
                dbgAddr.fTempBreak = true;
            }
            else {
                this.printBreakpoint(aBreak, aBreak.length-1);
                this.historyInit();
            }
        }

        // this.nSuppressBreaks--;

        return fSuccess;
    };

    /**
     * findBreakpoint(aBreak, dbgAddr, fRemove, fTempBreak, fQuiet)
     *
     * @this {Debugger}
     * @param {Array} aBreak
     * @param {DbgAddr} dbgAddr
     * @param {boolean} [fRemove]
     * @param {boolean} [fTempBreak]
     * @param {boolean} [fQuiet]
     * @return {boolean} true if found, false if not
     */
    Debugger.prototype.findBreakpoint = function(aBreak, dbgAddr, fRemove, fTempBreak, fQuiet)
    {
        var fFound = false;
        var addr = this.mapBreakpoint(this.getAddr(dbgAddr));
        for (var i = 1; i < aBreak.length; i++) {
            var dbgAddrBreak = aBreak[i];
            if (addr != X86.ADDR_INVALID && addr == this.mapBreakpoint(this.getAddr(dbgAddrBreak)) ||
                addr == X86.ADDR_INVALID && dbgAddr.sel == dbgAddrBreak.sel && dbgAddr.off == dbgAddrBreak.off) {
                if (!fTempBreak || dbgAddrBreak.fTempBreak) {
                    fFound = true;
                    if (fRemove) {
                        if (!dbgAddrBreak.fTempBreak) {
                            if (!fQuiet) this.printBreakpoint(aBreak, i, "cleared");
                        }
                        aBreak.splice(i, 1);
                        if (aBreak != this.aBreakExec) {
                            this.bus.removeMemBreak(addr, aBreak == this.aBreakWrite);
                        }
                        this.historyInit();
                        break;
                    }
                    if (!fQuiet) this.printBreakpoint(aBreak, i, "exists");
                    break;
                }
            }
        }
        return fFound;
    };

    /**
     * listBreakpoints(aBreak)
     *
     * @this {Debugger}
     * @param {Array} aBreak
     * @return {number} of breakpoints listed, 0 if none
     */
    Debugger.prototype.listBreakpoints = function(aBreak)
    {
        for (var i = 1; i < aBreak.length; i++) {
            this.printBreakpoint(aBreak, i);
        }
        return aBreak.length - 1;
    };

    /**
     * printBreakpoint(aBreak, i)
     *
     * TODO: We may need to start printing linear addresses also (if any), because segmented address can be ambiguous.
     *
     * @this {Debugger}
     * @param {Array} aBreak
     * @param {number} i
     * @param {string} [sAction]
     */
    Debugger.prototype.printBreakpoint = function(aBreak, i, sAction)
    {
        var dbgAddr = aBreak[i];
        this.println("breakpoint " + (sAction || "enabled") + ": " + this.hexAddr(dbgAddr) + " (" + aBreak[0] + ')' + (dbgAddr.sCmd? (' "' + dbgAddr.sCmd + '"') : ''));
    };

    /**
     * setTempBreakpoint(dbgAddr)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr of new temp breakpoint
     */
    Debugger.prototype.setTempBreakpoint = function(dbgAddr)
    {
        this.addBreakpoint(this.aBreakExec, dbgAddr, true);
    };

    /**
     * clearTempBreakpoint(addr)
     *
     * @this {Debugger}
     * @param {number|undefined} [addr] clear all temp breakpoints if no address specified
     */
    Debugger.prototype.clearTempBreakpoint = function(addr)
    {
        if (addr !== undefined) {
            this.checkBreakpoint(addr, 1, this.aBreakExec, true);
            this.nStep = 0;
        } else {
            for (var i = 1; i < this.aBreakExec.length; i++) {
                var dbgAddrBreak = this.aBreakExec[i];
                if (dbgAddrBreak.fTempBreak) {
                    if (!this.findBreakpoint(this.aBreakExec, dbgAddrBreak, true, true)) break;
                    i = 0;
                }
            }
        }
    };

    /**
     * mapBreakpoint(addr)
     *
     * @this {Debugger}
     * @param {number} addr
     * @return {number}
     */
    Debugger.prototype.mapBreakpoint = function(addr)
    {
        /*
         * Map addresses in the top 64Kb at the top of the address space (assuming either a 16Mb or 4Gb
         * address space) to the top of the 1Mb range.
         *
         * The fact that those two 64Kb regions are aliases of each other on an 80286 is a pain in the BUTT,
         * because any CS-based breakpoint you set immediately after a CPU reset will have a physical address
         * in the top 16Mb, yet after the first inter-segment JMP, you will be running in the first 1Mb.
         */
        if (addr != X86.ADDR_INVALID) {
            var mask = (this.maskAddr & ~0xffff);
            if ((addr & mask) == mask) addr &= 0x000fffff;
        }
        return addr;
    };

    /**
     * checkBreakpoint(addr, nb, aBreak, fTempBreak)
     *
     * @this {Debugger}
     * @param {number} addr
     * @param {number} nb (# of bytes)
     * @param {Array} aBreak
     * @param {boolean} [fTempBreak]
     * @return {boolean} true if breakpoint has been hit, false if not
     */
    Debugger.prototype.checkBreakpoint = function(addr, nb, aBreak, fTempBreak)
    {
        /*
         * Time to check for execution breakpoints; note that this should be done BEFORE updating frequency
         * or history data (see checkInstruction), since we might not actually execute the current instruction.
         */
        var fBreak = false;

        if (!this.nSuppressBreaks++) {

            addr = this.mapBreakpoint(addr);

            /*
             * As discussed in opINT3(), I decided to check for INT3 instructions here: we'll tell the CPU to
             * stop on INT3 whenever both the INT and HALT message bits are set; a simple "g" command allows you
             * to continue.
             */
            if (this.messageEnabled(Messages.INT | Messages.HALT)) {
                if (this.cpu.probeAddr(addr) == X86.OPCODE.INT3) {
                    fBreak = true;
                }
            }

            for (var i = 1; !fBreak && i < aBreak.length; i++) {

                var dbgAddrBreak = aBreak[i];

                if (fTempBreak && !dbgAddrBreak.fTempBreak) continue;

                /*
                 * We need to zap the linear address field of the breakpoint address before
                 * calling getAddr(), to force it to recalculate the linear address every time,
                 * unless this is a breakpoint on a linear address (as indicated by a null sel).
                 */
                if (dbgAddrBreak.sel != null) dbgAddrBreak.addr = null;

                /*
                 * We used to calculate the linear address of the breakpoint at the time the
                 * breakpoint was added, so that a breakpoint set in one mode (eg, in real-mode)
                 * would still work as intended if the mode changed later (eg, to protected-mode).
                 *
                 * However, that created difficulties setting protected-mode breakpoints in segments
                 * that might not be defined yet, or that could move in physical memory.
                 *
                 * If you want to create a real-mode breakpoint that will break regardless of mode,
                 * use the physical address of the real-mode memory location instead.
                 */
                var addrBreak = this.mapBreakpoint(this.getAddr(dbgAddrBreak));
                for (var n = 0; n < nb; n++) {
                    if (addr + n == addrBreak) {
                        var a;
                        fBreak = true;
                        if (dbgAddrBreak.fTempBreak) {
                            this.findBreakpoint(aBreak, dbgAddrBreak, true, true);
                            fTempBreak = true;
                        }
                        if (a = dbgAddrBreak.aCmds) {
                            /*
                             * When one or more commands are attached to a breakpoint, we don't halt by default.
                             * Instead, we set fBreak to true only if, at the completion of all the commands, the
                             * CPU is halted; in other words, you should include "h" as one of the breakpoint commands
                             * if you want the breakpoint to stop execution.
                             *
                             * Another useful command is "if", which will return false if the expression is false,
                             * at which point we'll jump ahead to the next "else" command, and if there isn't an "else",
                             * we abort.
                             */
                            fBreak = false;
                            for (var j = 0; j < a.length; j++) {
                                if (!this.doCommand(a[j], true)) {
                                    if (a[j].indexOf("if")) {
                                        fBreak = true;          // the failed command wasn't "if", so abort
                                        break;
                                    }
                                    var k = j + 1;
                                    for (; k < a.length; k++) {
                                        if (!a[k].indexOf("else")) break;
                                        j++;
                                    }
                                    if (k == a.length) {        // couldn't find an "else" after the "if", so abort
                                        fBreak = true;
                                        break;
                                    }
                                    /*
                                     * If we're still here, we'll execute the "else" command (which is just a no-op),
                                     * followed by any remaining commands.
                                     */
                                }
                            }
                            if (!this.cpu.isRunning()) fBreak = true;
                        }
                        if (fBreak) {
                            if (!fTempBreak) this.printBreakpoint(aBreak, i, "hit");
                            break;
                        }
                    }
                }
            }
        }

        this.nSuppressBreaks--;

        return fBreak;
    };

    /**
     * getInstruction(dbgAddr, sComment, nSequence)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {string} [sComment] is an associated comment
     * @param {number} [nSequence] is an associated sequence number, undefined if none
     * @return {string} (and dbgAddr is updated to the next instruction)
     */
    Debugger.prototype.getInstruction = function(dbgAddr, sComment, nSequence)
    {
        var dbgAddrIns = this.newAddr(dbgAddr.off, dbgAddr.sel, dbgAddr.addr, dbgAddr.type);

        var bOpcode = this.getByte(dbgAddr, 1);

        /*
         * Incorporate OPERAND and ADDRESS size prefixes into the current instruction.
         *
         * And the verdict is in: redundant OPERAND and ADDRESS prefixes must be ignored;
         * see opOS() and opAS() for details.  We limit the amount of redundancy to something
         * reasonable (ie, 4).
         */
        var cMaxOverrides = 4, cOverrides = 0;
        var fDataPrefix = false, fAddrPrefix = false;

        while ((bOpcode == X86.OPCODE.OS || bOpcode == X86.OPCODE.AS) && cMaxOverrides--) {
            if (bOpcode == X86.OPCODE.OS) {
                if (!fDataPrefix) {
                    dbgAddr.fData32 = !dbgAddr.fData32;
                    fDataPrefix = true;
                }
                cOverrides++;
            } else {
                if (!fAddrPrefix) {
                    dbgAddr.fAddr32 = !dbgAddr.fAddr32;
                    fAddrPrefix = true;
                }
                cOverrides++;
            }
            bOpcode = this.getByte(dbgAddr, 1);
        }

        var aOpDesc = this.aaOpDescs[bOpcode];
        var iIns = aOpDesc[0];
        var bModRM = -1;

        if (iIns == Debugger.INS.OP0F) {
            var b = this.getByte(dbgAddr, 1);
            aOpDesc = Debugger.aaOp0FDescs[b] || Debugger.aOpDescUndefined;
            bOpcode |= (b << 8);
            iIns = aOpDesc[0];
        }

        if (iIns >= Debugger.INS_NAMES.length) {
            bModRM = this.getByte(dbgAddr, 1);
            aOpDesc = Debugger.aaGrpDescs[iIns - Debugger.INS_NAMES.length][(bModRM >> 3) & 0x7];
        }

        var sOpcode = Debugger.INS_NAMES[aOpDesc[0]];
        var cOperands = aOpDesc.length - 1;
        var sOperands = "";
        if (this.isStringIns(bOpcode)) {
            cOperands = 0;              // suppress display of operands for string instructions
            if (dbgAddr.fData32 && sOpcode.slice(-1) == 'W') sOpcode = sOpcode.slice(0, -1) + 'D';
        }

        var typeCPU = null;
        var fComplete = true;

        for (var iOperand = 1; iOperand <= cOperands; iOperand++) {

            var disp, offset, cch;
            var sOperand = "";
            var type = aOpDesc[iOperand];
            if (type === undefined) continue;

            if (typeCPU == null) typeCPU = type >> Debugger.TYPE_CPU_SHIFT;

            var typeSize = type & Debugger.TYPE_SIZE;
            if (typeSize == Debugger.TYPE_NONE) {
                continue;
            }
            if (typeSize == Debugger.TYPE_PREFIX) {
                fComplete = false;
                continue;
            }
            var typeMode = type & Debugger.TYPE_MODE;
            if (typeMode >= Debugger.TYPE_MODRM) {
                if (bModRM < 0) {
                    bModRM = this.getByte(dbgAddr, 1);
                }
                if (typeMode < Debugger.TYPE_MODREG) {
                    /*
                     * This test also encompasses TYPE_MODMEM, which is basically the inverse of the case
                     * below (ie, only Mod values *other* than 11 are allowed); however, I believe that in
                     * some cases that's merely a convention, and that if you try to execute an instruction
                     * like "LEA AX,BX", it will actually do something (on some if not all processors), so
                     * there's probably some diagnostic value in allowing those cases to be disassembled.
                     */
                    sOperand = this.getModRMOperand(bModRM, type, cOperands, dbgAddr);
                }
                else if (typeMode == Debugger.TYPE_MODREG) {
                    /*
                     * TYPE_MODREG instructions assume that Mod is 11 (only certain early 80486 steppings
                     * actually *required* that Mod contain 11) and always treat RM as a register (which we
                     * could also simulate by setting Mod to 11 and letting getModRMOperand() do its thing).
                     */
                    sOperand = this.getRegOperand(bModRM & 0x7, type, dbgAddr);
                }
                else {
                    /*
                     * All the remaining cases are Reg-centric; getRegOperand() will figure out which case.
                     */
                    sOperand = this.getRegOperand((bModRM >> 3) & 0x7, type, dbgAddr);
                }
            }
            else if (typeMode == Debugger.TYPE_ONE) {
                sOperand = '1';
            }
            else if (typeMode == Debugger.TYPE_IMM) {
                sOperand = this.getImmOperand(type, dbgAddr);
            }
            else if (typeMode == Debugger.TYPE_IMMOFF) {
                if (!dbgAddr.fAddr32) {
                    cch = 4;
                    offset = this.getShort(dbgAddr, 2);
                } else {
                    cch = 8;
                    offset = this.getLong(dbgAddr, 4);
                }
                sOperand = '[' + str.toHex(offset, cch) + ']';
            }
            else if (typeMode == Debugger.TYPE_IMMREL) {
                if (typeSize == Debugger.TYPE_BYTE) {
                    disp = ((this.getByte(dbgAddr, 1) << 24) >> 24);
                }
                else {
                    disp = this.getWord(dbgAddr, true);
                }
                offset = (dbgAddr.off + disp) & (dbgAddr.fData32? -1 : 0xffff);
                sOperand = str.toHex(offset, dbgAddr.fData32? 8: 4);
                var aSymbol = this.findSymbol(this.newAddr(offset, dbgAddr.sel));
                if (aSymbol[0]) sOperand += " (" + aSymbol[0] + ")";
            }
            else if (typeMode == Debugger.TYPE_IMPREG) {
                sOperand = this.getRegOperand((type & Debugger.TYPE_IREG) >> 8, type, dbgAddr);
            }
            else if (typeMode == Debugger.TYPE_IMPSEG) {
                sOperand = this.getRegOperand((type & Debugger.TYPE_IREG) >> 8, Debugger.TYPE_SEGREG, dbgAddr);
            }
            else if (typeMode == Debugger.TYPE_DSSI) {
                sOperand = "DS:[SI]";
            }
            else if (typeMode == Debugger.TYPE_ESDI) {
                sOperand = "ES:[DI]";
            }
            if (!sOperand || !sOperand.length) {
                sOperands = "INVALID";
                break;
            }
            if (sOperands.length > 0) sOperands += ',';
            sOperands += (sOperand || "???");
        }

        var sBytes = "";
        var sLine = this.hexAddr(dbgAddrIns) + ' ';
        if (dbgAddrIns.addr != X86.ADDR_INVALID && dbgAddr.addr != X86.ADDR_INVALID) {
            do {
                sBytes += str.toHex(this.getByte(dbgAddrIns, 1), 2);
                if (dbgAddrIns.addr == null) break;
            } while (dbgAddrIns.addr != dbgAddr.addr);
        }

        sLine += str.pad(sBytes, dbgAddrIns.fAddr32? 24 : 16);
        sLine += str.pad(sOpcode, 8);
        if (sOperands) sLine += ' ' + sOperands;

        if (this.cpu.model < Debugger.CPUS[typeCPU]) {
            sComment = Debugger.CPUS[typeCPU] + " CPU only";
        }

        if (sComment && fComplete) {
            sLine = str.pad(sLine, dbgAddrIns.fAddr32? 74 : 56) + ';' + sComment;
            if (!this.cpu.aFlags.fChecksum) {
                sLine += (nSequence != null? '=' + nSequence.toString() : "");
            } else {
                var nCycles = this.cpu.getCycles();
                sLine += "cycles=" + nCycles.toString() + " cs=" + str.toHex(this.cpu.aCounts.nChecksum);
            }
        }

        this.initAddrSize(dbgAddr, fComplete, cOverrides);
        return sLine;
    };

    /**
     * getImmOperand(type, dbgAddr)
     *
     * @this {Debugger}
     * @param {number} type
     * @param {DbgAddr} dbgAddr
     * @return {string} operand
     */
    Debugger.prototype.getImmOperand = function(type, dbgAddr)
    {
        var sOperand = ' ';
        var typeSize = type & Debugger.TYPE_SIZE;

        switch (typeSize) {
        case Debugger.TYPE_BYTE:
            /*
             * There's the occasional immediate byte we don't need to display (eg, the 0x0A
             * following an AAM or AAD instruction), so we suppress the byte if it lacks a TYPE_IN
             * or TYPE_OUT designation (and TYPE_BOTH, as the name implies, includes both).
             */
            if (type & Debugger.TYPE_BOTH) {
                sOperand = str.toHex(this.getByte(dbgAddr, 1), 2);
            }
            break;
        case Debugger.TYPE_SBYTE:
            sOperand = str.toHex((this.getByte(dbgAddr, 1) << 24) >> 24, dbgAddr.fData32? 8: 4);
            break;
        case Debugger.TYPE_VWORD:
        case Debugger.TYPE_2WORD:
            if (dbgAddr.fData32) {
                sOperand = str.toHex(this.getLong(dbgAddr, 4));
                break;
            }
            /* falls through */
        case Debugger.TYPE_WORD:
            sOperand = str.toHex(this.getShort(dbgAddr, 2), 4);
            break;
        case Debugger.TYPE_FARP:
            dbgAddr = this.newAddr(this.getWord(dbgAddr, true), this.getShort(dbgAddr, 2), null, dbgAddr.type, dbgAddr.fData32, dbgAddr.fAddr32);
            sOperand = this.hexAddr(dbgAddr);
            var aSymbol = this.findSymbol(dbgAddr);
            if (aSymbol[0]) sOperand += " (" + aSymbol[0] + ")";
            break;
        default:
            sOperand = "imm(" + str.toHexWord(type) + ')';
            break;
        }
        return sOperand;
    };

    /**
     * getRegOperand(bReg, type, dbgAddr)
     *
     * @this {Debugger}
     * @param {number} bReg
     * @param {number} type
     * @param {DbgAddr} dbgAddr
     * @return {string} operand
     */
    Debugger.prototype.getRegOperand = function(bReg, type, dbgAddr)
    {
        var typeMode = type & Debugger.TYPE_MODE;
        if (typeMode == Debugger.TYPE_SEGREG) {
            if (bReg > Debugger.REG_GS ||
                bReg >= Debugger.REG_FS && this.cpu.model < X86.MODEL_80386) return "??";
            bReg += Debugger.REG_SEG;
        }
        else if (typeMode == Debugger.TYPE_CTLREG) {
            bReg += Debugger.REG_CR0;
        }
        else if (typeMode == Debugger.TYPE_DBGREG) {
            bReg += Debugger.REG_DR0;
        }
        else if (typeMode == Debugger.TYPE_TSTREG) {
            bReg += Debugger.REG_TR0;
        }
        else {
            var typeSize = type & Debugger.TYPE_SIZE;
            if (typeSize >= Debugger.TYPE_WORD) {
                if (bReg < Debugger.REG_AX) {
                    bReg += Debugger.REG_AX - Debugger.REG_AL;
                }
                if (typeSize == Debugger.TYPE_DWORD || typeSize == Debugger.TYPE_VWORD && dbgAddr.fData32) {
                    bReg += Debugger.REG_EAX - Debugger.REG_AX;
                }
            }
        }
        return Debugger.REGS[bReg];
    };

    /**
     * getSIBOperand(bMod, dbgAddr)
     *
     * @this {Debugger}
     * @param {number} bMod
     * @param {DbgAddr} dbgAddr
     * @return {string} operand
     */
    Debugger.prototype.getSIBOperand = function(bMod, dbgAddr)
    {
        var bSIB = this.getByte(dbgAddr, 1);
        var bScale = bSIB >> 6;
        var bIndex = (bSIB >> 3) & 0x7;
        var bBase = bSIB & 0x7;
        var sOperand = "";
        /*
         * Unless bMod is zero AND bBase is 5, there's always a base register.
         */
        if (bMod || bBase != 5) {
            sOperand = Debugger.RMS[bBase + 8];
        }
        if (bIndex != 4) {
            if (sOperand) sOperand += '+';
            sOperand += Debugger.RMS[bIndex + 8];
            if (bScale) sOperand += '*' + (0x1 << bScale);
        }
        /*
         * If bMod is zero AND bBase is 5, there's a 32-bit displacement instead of a base register.
         */
        if (!bMod && bBase == 5) {
            if (sOperand) sOperand += '+';
            sOperand += str.toHex(this.getLong(dbgAddr, 4));
        }
        return sOperand;
    };

    /**
     * getModRMOperand(bModRM, type, cOperands, dbgAddr)
     *
     * @this {Debugger}
     * @param {number} bModRM
     * @param {number} type
     * @param {number} cOperands (if 1, memory operands are prefixed with the size; otherwise, size can be inferred)
     * @param {DbgAddr} dbgAddr
     * @return {string} operand
     */
    Debugger.prototype.getModRMOperand = function(bModRM, type, cOperands, dbgAddr)
    {
        var sOperand = "";
        var bMod = bModRM >> 6;
        var bRM = bModRM & 0x7;
        if (bMod < 3) {
            var disp;
            if (!bMod && (!dbgAddr.fAddr32 && bRM == 6 || dbgAddr.fAddr32 && bRM == 5)) {
                bMod = 2;
            } else {
                if (dbgAddr.fAddr32) {
                    if (bRM != 4) {
                        bRM += 8;
                    } else {
                        sOperand = this.getSIBOperand(bMod, dbgAddr);
                    }
                }
                if (!sOperand) sOperand = Debugger.RMS[bRM];
            }
            if (bMod == 1) {
                disp = this.getByte(dbgAddr, 1);
                if (!(disp & 0x80)) {
                    sOperand += '+' + str.toHex(disp, 2);
                }
                else {
                    disp = ((disp << 24) >> 24);
                    sOperand += '-' + str.toHex(-disp, 2);
                }
            }
            else if (bMod == 2) {
                if (sOperand) sOperand += '+';
                if (!dbgAddr.fAddr32) {
                    disp = this.getShort(dbgAddr, 2);
                    sOperand += str.toHex(disp, 4);
                } else {
                    disp = this.getLong(dbgAddr, 4);
                    sOperand += str.toHex(disp);
                }
            }
            sOperand = '[' + sOperand + ']';
            if (cOperands == 1) {
                var sPrefix = "";
                type &= Debugger.TYPE_SIZE;
                if (type == Debugger.TYPE_VWORD) {
                    type = (dbgAddr.fData32? Debugger.TYPE_DWORD : Debugger.TYPE_WORD);
                }
                switch(type) {
                case Debugger.TYPE_FARP:
                    sPrefix = "FAR";
                    break;
                case Debugger.TYPE_BYTE:
                    sPrefix = "BYTE";
                    break;
                case Debugger.TYPE_WORD:
                    sPrefix = "WORD";
                    break;
                case Debugger.TYPE_DWORD:
                    sPrefix = "DWORD";
                    break;
                }
                if (sPrefix) sOperand = sPrefix + ' ' + sOperand;
            }
        }
        else {
            sOperand = this.getRegOperand(bRM, type, dbgAddr);
        }
        return sOperand;
    };

    /**
     * parseInstruction(sOp, sOperand, addr)
     *
     * TODO: Unimplemented.  See parseInstruction() in modules/c1pjs/lib/debugger.js for a working implementation.
     *
     * @this {Debugger}
     * @param {string} sOp
     * @param {string|undefined} sOperand
     * @param {DbgAddr} dbgAddr of memory where this instruction is being assembled
     * @return {Array.<number>} of opcode bytes; if the instruction can't be parsed, the array will be empty
     */
    Debugger.prototype.parseInstruction = function(sOp, sOperand, dbgAddr)
    {
        var aOpBytes = [];
        this.println("not supported yet");
        return aOpBytes;
    };

    /**
     * getFlagOutput(sFlag)
     *
     * @this {Debugger}
     * @param {string} sFlag
     * @return {string} value of flag
     */
    Debugger.prototype.getFlagOutput = function(sFlag)
    {
        var b;
        switch (sFlag) {
        case 'V':
            b = this.cpu.getOF();
            break;
        case 'D':
            b = this.cpu.getDF();
            break;
        case 'I':
            b = this.cpu.getIF();
            break;
        case 'T':
            b = this.cpu.getTF();
            break;
        case 'S':
            b = this.cpu.getSF();
            break;
        case 'Z':
            b = this.cpu.getZF();
            break;
        case 'A':
            b = this.cpu.getAF();
            break;
        case 'P':
            b = this.cpu.getPF();
            break;
        case 'C':
            b = this.cpu.getCF();
            break;
        default:
            b = 0;
            break;
        }
        return sFlag + (b? '1' : '0') + ' ';
    };

    /**
     * getLimitString(l)
     *
     * @this {Debugger}
     * @param {number} l
     * @return {string}
     */
    Debugger.prototype.getLimitString = function(l)
    {
        return str.toHex(l, (l & ~0xffff)? 8 : 4);
    };

    /**
     * getRegOutput(iReg)
     *
     * @this {Debugger}
     * @param {number} iReg
     * @return {string}
     */
    Debugger.prototype.getRegOutput = function(iReg)
    {
        if (iReg >= Debugger.REG_AX && iReg <= Debugger.REG_DI && this.cchReg > 4) iReg += Debugger.REG_EAX - Debugger.REG_AX;
        var sReg = Debugger.REGS[iReg];
        if (iReg == Debugger.REG_CR0 && this.cpu.model == X86.MODEL_80286) sReg = "MS";
        return sReg + '=' + this.getRegString(iReg) + ' ';
    };

    /**
     * getSegOutput(seg, fProt)
     *
     * @this {Debugger}
     * @param {X86Seg} seg
     * @param {boolean} [fProt]
     * @return {string}
     */
    Debugger.prototype.getSegOutput = function(seg, fProt)
    {
        return seg.sName + '=' + str.toHex(seg.sel, 4) + (fProt? '[' + str.toHex(seg.base, this.cchAddr) + ',' + this.getLimitString(seg.limit) + ']' : "");
    };

    /**
     * getDTROutput(sName, sel, addr, addrLimit)
     *
     * @this {Debugger}
     * @param {string} sName
     * @param {number|null} sel
     * @param {number} addr
     * @param {number} addrLimit
     * @return {string}
     */
    Debugger.prototype.getDTROutput = function(sName, sel, addr, addrLimit)
    {
        return sName + '=' + (sel != null? str.toHex(sel, 4) : "") + '[' + str.toHex(addr, this.cchAddr) + ',' + str.toHex(addrLimit - addr, 4) + ']';
    };

    /**
     * getRegDump(fProt)
     *
     * Sample 8086 and 80286 real-mode register dump:
     *
     *      AX=0000 BX=0000 CX=0000 DX=0000 SP=0000 BP=0000 SI=0000 DI=0000
     *      SS=0000 DS=0000 ES=0000 PS=0002 V0 D0 I0 T0 S0 Z0 A0 P0 C0
     *      F000:FFF0 EA5BE000F0    JMP      F000:E05B
     *
     * Sample 80386 real-mode register dump:
     *
     *      EAX=00000000 EBX=00000000 ECX=00000000 EDX=00000000
     *      ESP=00000000 EBP=00000000 ESI=00000000 EDI=00000000
     *      SS=0000 DS=0000 ES=0000 FS=0000 GS=0000 PS=00000002 V0 D0 I0 T0 S0 Z0 A0 P0 C0
     *      F000:FFF0 EA05F900F0    JMP      F000:F905
     *
     * Sample 80286 protected-mode register dump:
     *
     *      AX=0000 BX=0000 CX=0000 DX=0000 SP=0000 BP=0000 SI=0000 DI=0000
     *      SS=0000[000000,FFFF] DS=0000[000000,FFFF] ES=0000[000000,FFFF] A20=ON
     *      CS=F000[FF0000,FFFF] LD=0000[000000,FFFF] GD=[000000,FFFF] ID=[000000,03FF]
     *      TR=0000 MS=FFF0 PS=0002 V0 D0 I0 T0 S0 Z0 A0 P0 C0
     *      F000:FFF0 EA5BE000F0    JMP      F000:E05B
     *
     * Sample 80386 protected-mode register dump:
     *
     *      EAX=00000000 EBX=00000000 ECX=00000000 EDX=00000000
     *      ESP=00000000 EBP=00000000 ESI=00000000 EDI=00000000
     *      SS=0000[00000000,FFFF] DS=0000[00000000,FFFF] ES=0000[00000000,FFFF]
     *      CS=F000[FFFF0000,FFFF] FS=0000[00000000,FFFF] GS=0000[00000000,FFFF]
     *      LD=0000[00000000,FFFF] GD=[00000000,FFFF] ID=[00000000,03FF] TR=0000 A20=ON
     *      CR0=00000010 CR2=00000000 CR3=00000000 PS=00000002 V0 D0 I0 T0 S0 Z0 A0 P0 C0
     *      F000:0000FFF0 EA05F900F0    JMP      F000:0000F905
     *
     * This no longer includes CS in real-mode (or EIP in any mode), because that information can be obtained from the
     * first line of disassembly, which an "r" or "rp" command will also display.
     *
     * Note that even when the processor is in real mode, you can always use the "rp" command to force a protected-mode
     * dump, in case you need to verify any selector base or limit values, since those also affect real-mode operation.
     *
     * @this {Debugger}
     * @param {boolean} [fProt]
     * @return {string}
     */
    Debugger.prototype.getRegDump = function(fProt)
    {
        var s;
        if (fProt === undefined) fProt = this.getCurrentMode();

        s = this.getRegOutput(Debugger.REG_AX) +
            this.getRegOutput(Debugger.REG_BX) +
            this.getRegOutput(Debugger.REG_CX) +
            this.getRegOutput(Debugger.REG_DX) + (this.cchReg > 4? '\n' : '') +
            this.getRegOutput(Debugger.REG_SP) +
            this.getRegOutput(Debugger.REG_BP) +
            this.getRegOutput(Debugger.REG_SI) +
            this.getRegOutput(Debugger.REG_DI) + '\n' +
            this.getSegOutput(this.cpu.segSS, fProt) + ' ' +
            this.getSegOutput(this.cpu.segDS, fProt) + ' ' +
            this.getSegOutput(this.cpu.segES, fProt) + ' ';

        if (fProt) {
            var sTR = "TR=" + str.toHex(this.cpu.segTSS.sel, 4);
            var sA20 = "A20=" + (this.bus.getA20()? "ON " : "OFF ");
            if (this.cpu.model < X86.MODEL_80386) {
                sTR = '\n' + sTR;
                s += sA20; sA20 = '';
            }
            s += '\n' + this.getSegOutput(this.cpu.segCS, fProt) + ' ';
            if (I386 && this.cpu.model >= X86.MODEL_80386) {
                sA20 += '\n';
                s += this.getSegOutput(this.cpu.segFS, fProt) + ' ' +
                     this.getSegOutput(this.cpu.segGS, fProt) + '\n';
            }
            s += this.getDTROutput("LD", this.cpu.segLDT.sel, this.cpu.segLDT.base, this.cpu.segLDT.base + this.cpu.segLDT.limit) + ' ' +
                 this.getDTROutput("GD", null, this.cpu.addrGDT, this.cpu.addrGDTLimit) + ' ' +
                 this.getDTROutput("ID", null, this.cpu.addrIDT, this.cpu.addrIDTLimit) + ' ';
            s += sTR + ' ' + sA20;
            s += this.getRegOutput(Debugger.REG_CR0);
            if (I386 && this.cpu.model >= X86.MODEL_80386) {
                s += this.getRegOutput(Debugger.REG_CR2) + this.getRegOutput(Debugger.REG_CR3);
            }
        } else {
            if (I386 && this.cpu.model >= X86.MODEL_80386) {
                s += this.getSegOutput(this.cpu.segFS, fProt) + ' ' +
                     this.getSegOutput(this.cpu.segGS, fProt) + ' ';
            }
        }

        s += this.getRegOutput(Debugger.REG_PS) +
             this.getFlagOutput('V') + this.getFlagOutput('D') + this.getFlagOutput('I') + this.getFlagOutput('T') +
             this.getFlagOutput('S') + this.getFlagOutput('Z') + this.getFlagOutput('A') + this.getFlagOutput('P') + this.getFlagOutput('C');

        return s;
    };

    /**
     * parseAddr(sAddr, type, fNoChecks, fQuiet)
     *
     * As discussed above, dbgAddr variables contain one or more of: off, sel, and addr.  They represent
     * a segmented address (sel:off) when sel is defined or a linear address (addr) when sel is undefined
     * (or null).
     *
     * To create a segmented address, specify two values separated by ':'; for a linear address, use
     * a '%' prefix.  We check for ':' after '%', so if for some strange reason you specify both, the
     * address will be treated as segmented, not linear.
     *
     * The '%' syntax is similar to that used by the Windows 80386 kernel debugger (wdeb386) for linear
     * addresses.  If/when we add support for processors with page tables, we will likely adopt the same
     * convention for linear addresses and provide a different syntax (eg, "%%") physical memory references.
     *
     * Address evaluation and validation (eg, range checks) are no longer performed at this stage.  That's
     * done later, by getAddr(), which returns X86.ADDR_INVALID for invalid segments, out-of-range offsets,
     * etc.  The Debugger's low-level get/set memory functions verify all getAddr() results, but even if an
     * invalid address is passed through to the Bus memory interfaces, the address will simply be masked with
     * Bus.nBusLimit; in the case of X86.ADDR_INVALID, that will generally refer to the top of the physical
     * address space.
     *
     * @this {Debugger}
     * @param {string|undefined} sAddr
     * @param {number|undefined} [type] is either CODE or DATA, in case sAddr doesn't specify a segment
     * @param {boolean} [fNoChecks] (eg, true when setting breakpoints that may not be valid now, but will be later)
     * @param {boolean} [fQuiet]
     * @return {DbgAddr|null|undefined}
     */
    Debugger.prototype.parseAddr = function(sAddr, type, fNoChecks, fQuiet)
    {
        var dbgAddr, fPrint;
        var dbgAddrNext = (type === Debugger.ADDR.CODE? this.dbgAddrNextCode : this.dbgAddrNextData);

        var off = dbgAddrNext.off, sel = dbgAddrNext.sel, addr = dbgAddrNext.addr;

        type = fNoChecks? Debugger.ADDR.NONE : dbgAddrNext.type;

        if (fQuiet) fPrint = false;

        if (sAddr !== undefined) {

            var ch = sAddr.charAt(0);
            var iColon = sAddr.indexOf(':');

            switch(ch) {
            case '&':
                type = Debugger.ADDR.REAL;
                break;
            case '#':
                type = Debugger.ADDR.PROT;
                break;
            case '%':
                type = Debugger.ADDR.LINEAR;
                off = addr = 0;
                sel = null;             // we still have code that relies on this crutch, instead of the type field
                break;
            default:
                if (iColon >= 0) type = Debugger.ADDR.NONE;
                ch = '';
                break;
            }

            if (ch) {
                sAddr = sAddr.substr(1);
                iColon--;
            }

            dbgAddr = this.findSymbolAddr(sAddr);
            if (dbgAddr) return dbgAddr;

            if (iColon < 0) {
                if (sel != null) {
                    off = this.parseExpression(sAddr, fPrint);
                    addr = null;
                } else {
                    addr = this.parseExpression(sAddr, fPrint);
                    if (addr == null) off = null;
                }
            }
            else {
                sel = this.parseExpression(sAddr.substring(0, iColon), fPrint);
                off = this.parseExpression(sAddr.substring(iColon + 1), fPrint);
                addr = null;
            }
        }

        if (off != null) {
            dbgAddr = this.newAddr(off, sel, addr, type);
            if (!fNoChecks && !this.checkLimit(dbgAddr, true)) {
                this.println("invalid offset: " + this.hexAddr(dbgAddr));
                dbgAddr = null;
            }
        }
        return dbgAddr;
    };

    /**
     * parseAddrOptions(dbdAddr, sOptions)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {string} [sOptions]
     */
    Debugger.prototype.parseAddrOptions = function(dbgAddr, sOptions)
    {
        if (sOptions) {
            var a = sOptions.match(/(['"])(.*?)\1/);
            if (a) {
                dbgAddr.aCmds = this.parseCommand(dbgAddr.sCmd = a[2]);
            }
        }
    };

    Debugger.aBinOpPrecedence = {
        '||':   0,      // logical OR
        '&&':   1,      // logical AND
        '|':    2,      // bitwise OR
        '^':    3,      // bitwise XOR
        '&':    4,      // bitwise AND
        '!=':   5,      // inequality
        '==':   5,      // equality
        '>=':   6,      // greater than or equal to
        '>':    6,      // greater than
        '<=':   6,      // less than or equal to
        '<':    6,      // less than
        '>>>':  7,      // unsigned bitwise right shift
        '>>':   7,      // bitwise right shift
        '<<':   7,      // bitwise left shift
        '-':    8,      // subtraction
        '+':    8,      // addition
        '%':    9,      // remainder
        '/':    9,      // division
        '*':    9       // multiplication
    };

    /**
     * evalExpression(aVals, aOps, cOps)
     *
     * @this {Debugger}
     * @param {Array.<number>} aVals
     * @param {Array.<string>} aOps
     * @param {number} [cOps] (default is all)
     * @return {boolean} true if successful, false if error
     */
    Debugger.prototype.evalExpression = function(aVals, aOps, cOps)
    {
        cOps = cOps || -1;
        while (cOps-- && aOps.length) {
            var chOp = aOps.pop();
            if (aVals.length < 2) return false;
            var valNew;
            var val2 = aVals.pop();
            var val1 = aVals.pop();
            switch(chOp) {
            case '*':
                valNew = val1 * val2;
                break;
            case '/':
                if (!val2) return false;
                valNew = val1 / val2;
                break;
            case '%':
                if (!val2) return false;
                valNew = val1 % val2;
                break;
            case '+':
                valNew = val1 + val2;
                break;
            case '-':
                valNew = val1 - val2;
                break;
            case '<<':
                valNew = val1 << val2;
                break;
            case '>>':
                valNew = val1 >> val2;
                break;
            case '>>>':
                valNew = val1 >>> val2;
                break;
            case '<':
                valNew = (val1 < val2? 1 : 0);
                break;
            case '<=':
                valNew = (val1 <= val2? 1 : 0);
                break;
            case '>':
                valNew = (val1 > val2? 1 : 0);
                break;
            case '>=':
                valNew = (val1 >= val2? 1 : 0);
                break;
            case '==':
                valNew = (val1 == val2? 1 : 0);
                break;
            case '!=':
                valNew = (val1 != val2? 1 : 0);
                break;
            case '&':
                valNew = val1 & val2;
                break;
            case '^':
                valNew = val1 ^ val2;
                break;
            case '|':
                valNew = val1 | val2;
                break;
            case '&&':
                valNew = (val1 && val2? 1 : 0);
                break;
            case '||':
                valNew = (val1 || val2? 1 : 0);
                break;
            default:
                return false;
            }
            aVals.push(valNew|0);
        }
        return true;
    };

    /**
     * parseExpression(sExp, fPrint)
     *
     * A quick-and-dirty expression parser.  It takes an expression like:
     *
     *      EDX+EDX*4+12345678
     *
     * and builds a value stack in aVals and a "binop" (binary operator) stack in aOps:
     *
     *      aVals       aOps
     *      -----       ----
     *      EDX         +
     *      EDX         *
     *      4           +
     *      ...
     *
     * We pop 1 "binop" from aOps and 2 values from aVals whenever a "binop" of lower priority than its
     * predecessor is encountered, evaluate, and push the result back onto aVals.
     *
     * Unary operators like '~' and ternary operators like '?:' are not supported; neither are parentheses.
     *
     * However, parseReference() now makes it possible to write parenthetical-style sub-expressions by using
     * {...} (braces), as well as address references by using [...] (brackets).
     *
     * Why am I using braces instead of parentheses for sub-expressions?  Because parseReference() serves
     * multiple purposes, the other being reference replacement in message strings passing through replaceRegs(),
     * and I didn't want parentheses taking on a new meaning in message strings.
     *
     * @this {Debugger}
     * @param {string|undefined} sExp
     * @param {boolean} [fPrint] is true to print all resolved values, false for quiet parsing
     * @return {number|undefined} numeric value, or undefined if sExp contains any undefined or invalid values
     */
    Debugger.prototype.parseExpression = function(sExp, fPrint)
    {
        var value;

        if (sExp) {
            /*
             * First process (and eliminate) any references, aka sub-expressions.
             */
            sExp = this.parseReference(sExp);

            var i = 0;
            var fError = false;
            var sExpOrig = sExp;
            var aVals = [], aOps = [];
            /*
             * All browsers (including, I believe, IE9 and up) support the following idiosyncrasy of a regexp split():
             * when the regexp uses a capturing pattern, the resulting array will include entries for all the pattern
             * matches along with the non-matches.  This effectively means that, in the set of expressions that we
             * support, all even entries in asValues will contain "values" and all odd entries will contain "operators".
             *
             * And although I tried to list the supported operators in "precedential" order, bitwise operators must
             * be out-of-order so that we don't mistakenly match either '>' or '<' when they're part of '>>' or '<<'.
             */
            var regExp = /(\|\||&&|\||^|&|!=|==|>=|>>>|>>|>|<=|<<|<|-|\+|%|\/|\*)/;
            var asValues = sExp.split(regExp);
            while (i < asValues.length) {
                var sValue = asValues[i++];
                var cchValue = sValue.length;
                var s = str.trim(sValue);
                if (!s) {
                    fError = true;
                    break;
                }
                var v = this.parseValue(s, null, fPrint === false);
                if (v === undefined) {
                    fError = true;
                    fPrint = false;
                    break;
                }
                aVals.push(v);
                if (i == asValues.length) break;
                var sOp = asValues[i++], cchOp = sOp.length;
                this.assert(Debugger.aBinOpPrecedence[sOp] != null);
                if (aOps.length && Debugger.aBinOpPrecedence[sOp] < Debugger.aBinOpPrecedence[aOps[aOps.length-1]]) {
                    this.evalExpression(aVals, aOps, 1);
                }
                aOps.push(sOp);
                sExp = sExp.substr(cchValue + cchOp);
            }
            if (!this.evalExpression(aVals, aOps) || aVals.length != 1) {
                fError = true;
            }
            if (!fError) {
                value = aVals.pop();
                if (fPrint) this.printValue(null, value);
            } else {
                if (fPrint) this.println("error parsing '" + sExpOrig + "' at character " + (sExpOrig.length - sExp.length));
            }
        }
        return value;
    };

    /**
     * parseReference(sValue)
     *
     * Returns the given string with any "{expression}" sequences replaced with the value of the expression,
     * and any "[address]" references replaced with the contents of the address.  Expressions are parsed BEFORE
     * addresses.  Owing to this function's simplistic parsing, nested braces/brackets are not supported
     * (define intermediate variables if needed).
     *
     * @this {Debugger}
     * @param {string} sValue
     * @return {string}
     */
    Debugger.prototype.parseReference = function(sValue)
    {
        var a;
        while (a = sValue.match(/\{(.*?)\}/)) {
            var value = this.parseExpression(a[1]);
            sValue = sValue.replace('{' + a[1] + '}', value != null? str.toHex(value) : "undefined");
        }
        while (a = sValue.match(/\[(.*?)\]/)) {
            var sAddr = this.parseReference(a[1]);      // take care of any inner references, too
            var dbgAddr = this.parseAddr(sAddr);
            sValue = sValue.replace('[' + a[1] + ']', dbgAddr? str.toHex(this.getWord(dbgAddr), dbgAddr.fData32? 8 : 4) : "undefined");
        }
        return sValue;
    };

    /**
     * parseValue(sValue, sName, fQuiet)
     *
     * @this {Debugger}
     * @param {string|undefined} sValue
     * @param {string|null} [sName] is the name of the value, if any
     * @param {boolean} [fQuiet]
     * @return {number|undefined} numeric value, or undefined if sValue is either undefined or invalid
     */
    Debugger.prototype.parseValue = function(sValue, sName, fQuiet)
    {
        var value;
        if (sValue !== undefined) {
            var iReg = this.getRegIndex(sValue);
            if (iReg >= 0) {
                value = this.getRegValue(iReg);
            } else {
                value = this.getVariable(sValue);
                if (value === undefined) value = str.parseInt(sValue);
            }
            if (value === undefined && !fQuiet) this.println("invalid " + (sName? sName : "value") + ": " + sValue);
        } else {
            if (!fQuiet) this.println("missing " + (sName || "value"));
        }
        return value;
    };

    /**
     * printValue(sVar, value)
     *
     * @this {Debugger}
     * @param {string|null} sVar
     * @param {number|undefined} value
     * @return {boolean} true if value defined, false if not
     */
    Debugger.prototype.printValue = function(sVar, value)
    {
        var sValue;
        var fDefined = false;
        if (value !== undefined) {
            fDefined = true;
            sValue = str.toHexLong(value) + " (" + value + ')'; /* + str.toBinBytes(value) */
        }
        sVar = (sVar != null? (sVar + ": ") : "");
        this.println(sVar + sValue);
        return fDefined;
    };

    /**
     * printVariable(sVar)
     *
     * @this {Debugger}
     * @param {string} [sVar]
     * @return {boolean} true if all value(s) defined, false if not
     */
    Debugger.prototype.printVariable = function(sVar)
    {
        if (sVar) {
            return this.printValue(sVar, this.aVariables[sVar]);
        }
        var cVariables = 0;
        for (sVar in this.aVariables) {
            this.printValue(sVar, this.aVariables[sVar]);
            cVariables++;
        }
        return cVariables > 0;
    };

    /**
     * delVariable(sVar)
     *
     * @this {Debugger}
     * @param {string} sVar
     */
    Debugger.prototype.delVariable = function(sVar)
    {
        delete this.aVariables[sVar];
    };

    /**
     * getVariable(sVar)
     *
     * @this {Debugger}
     * @param {string} sVar
     * @return {number|undefined}
     */
    Debugger.prototype.getVariable = function(sVar)
    {
        return this.aVariables[sVar];
    };

    /**
     * setVariable(sVar, value)
     *
     * @this {Debugger}
     * @param {string} sVar
     * @param {number} value
     */
    Debugger.prototype.setVariable = function(sVar, value)
    {
        this.aVariables[sVar] = value;
    };

    /**
     * addSymbols(addr, size, aSymbols)
     *
     * As filedump.js (formerly convrom.php) explains, aSymbols is a JSON-encoded object whose properties consist
     * of all the symbols (in upper-case), and the values of those properties are objects containing any or all of
     * the following properties:
     *
     *      'v': the value of an absolute (unsized) value
     *      'b': either 1, 2, 4 or undefined if an unsized value
     *      's': either a hard-coded segment or undefined
     *      'o': the offset of the symbol within the associated address space
     *      'l': the original-case version of the symbol, present only if it wasn't originally upper-case
     *      'a': annotation for the specified offset; eg, the original assembly language, with optional comment
     *
     * To that list of properties, we also add:
     *
     *      'p': the physical address (calculated whenever both 's' and 'o' properties are defined)
     *
     * Note that values for any 'v', 'b', 's' and 'o' properties are unquoted decimal values, and the values
     * for any 'l' or 'a' properties are quoted strings. Also, if double-quotes were used in any of the original
     * annotation ('a') values, they will have been converted to two single-quotes, so we're responsible for
     * converting them back to individual double-quotes.
     *
     * For example:
     *      {
     *          "HF_PORT": {
     *              "v":800
     *          },
     *          "HDISK_INT": {
     *              "b":4, "s":0, "o":52
     *          },
     *          "ORG_VECTOR": {
     *              "b":4, "s":0, "o":76
     *          },
     *          "CMD_BLOCK": {
     *              "b":1, "s":64, "o":66
     *          },
     *          "DISK_SETUP": {
     *              "o":3
     *          },
     *          ".40": {
     *              "o":40, "a":"MOV AX,WORD PTR ORG_VECTOR ;GET DISKETTE VECTOR"
     *          }
     *      }
     *
     * If a symbol only has an offset, then that offset value can be assigned to the symbol property directly:
     *
     *          "DISK_SETUP": 3
     *
     * The last property is an example of an "anonymous" entry, for offsets where there is no associated symbol.
     * Such entries are identified by a period followed by a unique number (usually the offset of the entry), and
     * they usually only contain offset ('o') and annotation ('a') properties.  I could eliminate the leading
     * period, but it offers a very convenient way of quickly discriminating among genuine vs. anonymous symbols.
     *
     * We add all these entries to our internal symbol table, which is an array of 4-element arrays, each of which
     * look like:
     *
     *      [addr, size, aSymbols, aOffsetPairs]
     *
     * There are two basic symbol operations: findSymbol(), which takes an address and finds the symbol, if any,
     * at that address, and findSymbolAddr(), which takes a string and attempts to match it to a non-anonymous
     * symbol with a matching offset ('o') property.
     *
     * To implement findSymbol() efficiently, addSymbols() creates an array of [offset, sSymbol] pairs
     * (aOffsetPairs), one pair for each symbol that corresponds to an offset within the specified address space.
     *
     * We guarantee the elements of aOffsetPairs are in offset order, because we build it using binaryInsert();
     * it's quite likely that the MAP file already ordered all its symbols in offset order, but since they're
     * hand-edited files, we can't assume that.  This ensures that findSymbol()'s binarySearch() will operate
     * properly.
     *
     * @this {Debugger}
     * @param {number} addr is the physical address of the region where the given symbols are located
     * @param {number} size is the size of the region, in bytes
     * @param {Object} aSymbols is the collection of symbols (the format of this object is described below)
     */
    Debugger.prototype.addSymbols = function(addr, size, aSymbols)
    {
        var dbgAddr = {};
        var aOffsetPairs = [];
        var fnComparePairs = function(p1, p2) {
            return p1[0] > p2[0]? 1 : p1[0] < p2[0]? -1 : 0;
        };
        for (var sSymbol in aSymbols) {
            var symbol = aSymbols[sSymbol];
            if (typeof symbol == "number") {
                aSymbols[sSymbol] = symbol = {'o': symbol};
            }
            var off = symbol['o'];
            var sel = symbol['s'];
            var sAnnotation = symbol['a'];
            if (off !== undefined) {
                if (sel !== undefined) {
                    dbgAddr.off = off;
                    dbgAddr.sel = sel;
                    dbgAddr.addr = null;
                    /*
                     * getAddr() computes the corresponding physical address and saves it in dbgAddr.addr.
                     */
                    this.getAddr(dbgAddr);
                    /*
                     * The physical address for any symbol located in the top 64Kb of the machine's address space
                     * should be relocated to the top 64Kb of the first 1Mb, so that we're immune from any changes
                     * to the A20 line.
                     */
                    if ((dbgAddr.addr & ~0xffff) == (this.bus.nBusLimit & ~0xffff)) {
                        dbgAddr.addr &= 0x000fffff;
                    }
                    symbol['p'] = dbgAddr.addr;
                }
                usr.binaryInsert(aOffsetPairs, [off, sSymbol], fnComparePairs);
            }
            if (sAnnotation) symbol['a'] = sAnnotation.replace(/''/g, "\"");
        }
        this.aSymbolTable.push([addr, size, aSymbols, aOffsetPairs]);
    };

    /**
     * dumpSymbols()
     *
     * TODO: Add "numerical" and "alphabetical" dump options. This is simply dumping them in whatever
     * order they appeared in the original MAP file.
     *
     * @this {Debugger}
     */
    Debugger.prototype.dumpSymbols = function()
    {
        for (var i = 0; i < this.aSymbolTable.length; i++) {
            var addr = this.aSymbolTable[i][0];
          //var size = this.aSymbolTable[i][1];
            var aSymbols = this.aSymbolTable[i][2];
            for (var sSymbol in aSymbols) {
                if (sSymbol.charAt(0) == '.') continue;
                var symbol = aSymbols[sSymbol];
                var off = symbol['o'];
                if (off === undefined) continue;
                var sel = symbol['s'];
                if (sel === undefined) sel = (addr >>> 4);
                var sSymbolOrig = aSymbols[sSymbol]['l'];
                if (sSymbolOrig) sSymbol = sSymbolOrig;
                this.println(this.hexOffset(off, sel) + ' ' + sSymbol);
            }
        }
    };

    /**
     * findSymbol(dbgAddr, fNearest)
     *
     * Search aSymbolTable for dbgAddr, and return an Array for the corresponding symbol (empty if not found).
     *
     * If fNearest is true, and no exact match was found, then the Array returned will contain TWO sets of
     * entries: [0]-[3] will refer to closest preceding symbol, and [4]-[7] will refer to the closest subsequent symbol.
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {boolean} [fNearest]
     * @return {Array} where [0] == symbol name, [1] == symbol value, [2] == any annotation, and [3] == any associated comment
     */
    Debugger.prototype.findSymbol = function(dbgAddr, fNearest)
    {
        var aSymbol = [];
        var addr = this.getAddr(dbgAddr);
        for (var iTable = 0; iTable < this.aSymbolTable.length; iTable++) {
            var addrSymbol = this.aSymbolTable[iTable][0];
            var sizeSymbol = this.aSymbolTable[iTable][1];
            if (addr >= addrSymbol && addr < addrSymbol + sizeSymbol) {
                var offset = dbgAddr.off;
                var aOffsetPairs = this.aSymbolTable[iTable][3];
                var fnComparePairs = function(p1, p2)
                {
                    return p1[0] > p2[0]? 1 : p1[0] < p2[0]? -1 : 0;
                };
                var result = usr.binarySearch(aOffsetPairs, [offset], fnComparePairs);
                if (result >= 0) {
                    this.returnSymbol(iTable, result, aSymbol);
                }
                else if (fNearest) {
                    result = ~result;
                    this.returnSymbol(iTable, result-1, aSymbol);
                    this.returnSymbol(iTable, result, aSymbol);
                }
                break;
            }
        }
        if (!aSymbol.length) {
            var sSymbol = this.bus.getSymbol(addr, true);
            if (sSymbol) {
                aSymbol.push(sSymbol);
                aSymbol.push(addr);
            }
        }
        return aSymbol;
    };

    /**
     * findSymbolAddr(sSymbol)
     *
     * Search aSymbolTable for sSymbol, and if found, return a dbgAddr (same as parseAddr())
     *
     * @this {Debugger}
     * @param {string} sSymbol
     * @return {DbgAddr|undefined}
     */
    Debugger.prototype.findSymbolAddr = function(sSymbol)
    {
        var dbgAddr;
        if (sSymbol.match(/^[a-z_][a-z0-9_]*$/i)) {
            var sUpperCase = sSymbol.toUpperCase();
            for (var i = 0; i < this.aSymbolTable.length; i++) {
                var addr = this.aSymbolTable[i][0];
                //var size = this.aSymbolTable[i][1];
                var aSymbols = this.aSymbolTable[i][2];
                var symbol = aSymbols[sUpperCase];
                if (symbol !== undefined) {
                    var off = symbol['o'];
                    if (off !== undefined) {
                        /*
                         * We assume that every ROM is ORG'ed at 0x0000, and therefore unless the symbol has an
                         * explicitly-defined segment, we return the segment as "addr >>> 4".  Down the road, we may
                         * want/need to support a special symbol entry (eg, ".ORG") that defines an alternate origin.
                         */
                        var sel = symbol['s'];
                        if (sel === undefined) sel = addr >>> 4;
                        dbgAddr = this.newAddr(off, sel, symbol['p']);
                    }
                    /*
                     * The symbol matched, but it wasn't for an address (no 'o' offset), and there's no point
                     * looking any farther, since each symbol appears only once, so we indicate it's an unknown symbol.
                     */
                    break;
                }
            }
        }
        return dbgAddr;
    };

    /**
     * returnSymbol(iTable, iOffset, aSymbol)
     *
     * Helper function for findSymbol().
     *
     * @param {number} iTable
     * @param {number} iOffset
     * @param {Array} aSymbol is updated with the specified symbol, if it exists
     */
    Debugger.prototype.returnSymbol = function(iTable, iOffset, aSymbol)
    {
        var symbol = {};
        var aOffsetPairs = this.aSymbolTable[iTable][3];
        var offset = 0, sSymbol = null;
        if (iOffset >= 0 && iOffset < aOffsetPairs.length) {
            offset = aOffsetPairs[iOffset][0];
            sSymbol = aOffsetPairs[iOffset][1];
        }
        if (sSymbol) {
            symbol = this.aSymbolTable[iTable][2][sSymbol];
            sSymbol = (sSymbol.charAt(0) == '.'? null : (symbol['l'] || sSymbol));
        }
        aSymbol.push(sSymbol);
        aSymbol.push(offset);
        aSymbol.push(symbol['a']);
        aSymbol.push(symbol['c']);
    };

    /**
     * doHelp()
     *
     * @this {Debugger}
     */
    Debugger.prototype.doHelp = function()
    {
        var s = "commands:";
        for (var sCommand in Debugger.COMMANDS) {
            s += '\n' + str.pad(sCommand, 7) + Debugger.COMMANDS[sCommand];
        }
        if (!this.checksEnabled()) s += "\nnote: frequency/history disabled if no exec breakpoints";
        this.println(s);
    };

    /**
     * doAssemble(asArgs)
     *
     * This always receives the complete argument array, where the order of the arguments is:
     *
     *      [0]: the assemble command (assumed to be "a")
     *      [1]: the target address (eg, "200")
     *      [2]: the operation code, aka instruction name (eg, "adc")
     *      [3]: the operation mode operand, if any (eg, "14", "[1234]", etc)
     *
     * The Debugger enters "assemble mode" whenever only the first (or first and second) arguments are present.
     * As long as "assemble mode is active, the user can omit the first two arguments on all later assemble commands
     * until "assemble mode" is cancelled with an empty command line; the command processor automatically prepends "a"
     * and the next available target address to the argument array.
     *
     * Entering "assemble mode" is optional; one could enter a series of fully-qualified assemble commands; eg:
     *
     *      a ff00 cld
     *      a ff01 ldx 28
     *      ...
     *
     * without ever entering "assemble mode", but of course, that requires more typing and doesn't take advantage
     * of automatic target address advancement (see dbgAddrAssemble).
     *
     * NOTE: As the previous example implies, you can even assemble new instructions into ROM address space;
     * as our setByte() function explains, the ROM write-notification handlers only refuse writes from the CPU.
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs is the complete argument array, beginning with the "a" command in asArgs[0]
     */
    Debugger.prototype.doAssemble = function(asArgs)
    {
        var dbgAddr = this.parseAddr(asArgs[1], Debugger.ADDR.CODE);
        if (!dbgAddr) return;

        this.dbgAddrAssemble = dbgAddr;
        if (asArgs[2] === undefined) {
            this.println("begin assemble @" + this.hexAddr(dbgAddr));
            this.fAssemble = true;
            this.cpu.updateCPU();
            return;
        }

        var aOpBytes = this.parseInstruction(asArgs[2], asArgs[3], dbgAddr);
        if (aOpBytes.length) {
            for (var i = 0; i < aOpBytes.length; i++) {
                this.setByte(dbgAddr, aOpBytes[i], 1);
            }
            /*
             * Since getInstruction() also updates the specified address, dbgAddrAssemble is automatically advanced.
             */
            this.println(this.getInstruction(this.dbgAddrAssemble));
        }
    };

    /**
     * doBreak(sCmd, sAddr, sOptions)
     *
     * As the "help" output below indicates, the following breakpoint commands are supported:
     *
     *      bp [a]  set exec breakpoint on linear addr [a]
     *      br [a]  set read breakpoint on linear addr [a]
     *      bw [a]  set write breakpoint on linear addr [a]
     *      bc [a]  clear breakpoint on linear addr [a] (use "*" for all breakpoints)
     *      bl      list breakpoints
     *
     * to which we have recently added the following I/O breakpoint commands:
     *
     *      bi [p]  toggle input breakpoint on port [p] (use "*" for all input ports)
     *      bo [p]  toggle output breakpoint on port [p] (use "*" for all output ports)
     *
     * These two new commands operate as toggles so that if "*" is used to trap all input (or output),
     * you can also use these commands to NOT trap specific ports.
     *
     * TODO: Update the "bl" command to include any/all I/O breakpoints, and the "bc" command to
     * clear them.  Because "bi" and "bo" commands are piggy-backing on Bus functions, those breakpoints
     * are currently outside the realm of what the "bl" and "bc" commands are aware of.
     *
     * @this {Debugger}
     * @param {string} sCmd
     * @param {string|undefined} [sAddr]
     * @param {string} [sOptions] (the rest of the breakpoint command-line)
     */
    Debugger.prototype.doBreak = function(sCmd, sAddr, sOptions)
    {
        if (sAddr == '?') {
            this.println("breakpoint commands:");
            this.println("\tbi [p]\ttoggle break on input port [p]");
            this.println("\tbo [p]\ttoggle break on output port [p]");
            this.println("\tbp [a]\tset exec breakpoint at addr [a]");
            this.println("\tbr [a]\tset read breakpoint at addr [a]");
            this.println("\tbw [a]\tset write breakpoint at addr [a]");
            this.println("\tbc [a]\tclear breakpoint at addr [a]");
            this.println("\tbl\tlist all breakpoints");
            return;
        }
        var sParm = sCmd.charAt(1);
        if (sParm == 'l') {
            var cBreaks = 0;
            cBreaks += this.listBreakpoints(this.aBreakExec);
            cBreaks += this.listBreakpoints(this.aBreakRead);
            cBreaks += this.listBreakpoints(this.aBreakWrite);
            if (!cBreaks) this.println("no breakpoints");
            return;
        }
        if (sAddr === undefined) {
            this.println("missing breakpoint address");
            return;
        }
        var dbgAddr = {};
        if (sAddr != '*') {
            dbgAddr = this.parseAddr(sAddr, Debugger.ADDR.CODE, true);
            if (!dbgAddr) return;
        }

        sAddr = (dbgAddr.off == null? sAddr : str.toHexWord(dbgAddr.off));

        if (sParm == 'c') {
            if (dbgAddr.off == null) {
                this.clearBreakpoints();
                this.println("all breakpoints cleared");
                return;
            }
            if (this.findBreakpoint(this.aBreakExec, dbgAddr, true))
                return;
            if (this.findBreakpoint(this.aBreakRead, dbgAddr, true))
                return;
            if (this.findBreakpoint(this.aBreakWrite, dbgAddr, true))
                return;
            this.println("breakpoint missing: " + this.hexAddr(dbgAddr));
            return;
        }

        if (sParm == 'i') {
            this.println("breakpoint " + (this.bus.addPortInputBreak(dbgAddr.off)? "enabled" : "cleared") + ": port " + sAddr + " (input)");
            return;
        }

        if (sParm == 'o') {
            this.println("breakpoint " + (this.bus.addPortOutputBreak(dbgAddr.off)? "enabled" : "cleared") + ": port " + sAddr + " (output)");
            return;
        }

        if (dbgAddr.off == null) return;

        this.parseAddrOptions(dbgAddr, sOptions);

        if (sParm == 'p') {
            this.addBreakpoint(this.aBreakExec, dbgAddr);
            return;
        }
        if (sParm == 'r') {
            this.addBreakpoint(this.aBreakRead, dbgAddr);
            return;
        }
        if (sParm == 'w') {
            this.addBreakpoint(this.aBreakWrite, dbgAddr);
            return;
        }
        this.println("unknown breakpoint command: " + sParm);
    };

    /**
     * doClear(sCmd)
     *
     * @this {Debugger}
     * @param {string} [sCmd] (eg, "cls" or "clear")
     */
    Debugger.prototype.doClear = function(sCmd)
    {
        /*
         * TODO: There should be a clear() component method that the Control Panel overrides to perform this function.
         */
        if (this.controlPrint) this.controlPrint.value = "";
    };

    /**
     * doDump(asArgs)
     *
     * The length parameter is interpreted as a number of bytes, in hex, which we convert to the appropriate number
     * of lines, because we always display whole lines.  If the length is omitted/undefined, it defaults to 0x80 (128.)
     * bytes, which normally translates to 8 lines.
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs (formerly sCmd, [sAddr], [sLen] and [sBytes])
     */
    Debugger.prototype.doDump = function(asArgs)
    {
        var m;
        var sCmd = asArgs[0];
        var sAddr = asArgs[1];
        var sLen = asArgs[2];
        var sBytes = asArgs[3];

        if (sAddr == '?') {
            var sDumpers = "";
            for (m in Debugger.MESSAGES) {
                if (this.afnDumpers[m]) {
                    if (sDumpers) sDumpers += ',';
                    sDumpers = sDumpers + m;
                }
            }
            sDumpers += ",state,symbols";
            this.println("dump memory commands:");
            this.println("\tdb [a] [#]    dump # bytes at address a");
            this.println("\tdw [a] [#]    dump # words at address a");
            this.println("\tdd [a] [#]    dump # dwords at address a");
            this.println("\tdh [#] [#]    dump # instructions from history");
            if (BACKTRACK) {
                this.println("\tdi [a]        dump backtrack info for address a");
            }
            this.println("\tds [#]        dump descriptor info for selector #");
            if (sDumpers.length) this.println("dump extension commands:\n\t" + sDumpers);
            return;
        }

        if (sAddr == "state") {
            var s = this.cmp.powerOff(true);
            if (sLen == "console") {
                /*
                 * Console buffers are notoriously small, and even the following code, which breaks the
                 * data into parts (eg, "d state console 1", "d state console 2", etc) just isn't that helpful.
                 *
                 *      var nPart = +sBytes;
                 *      if (nPart) s = s.substr(1000000 * (nPart-1), 1000000);
                 *
                 * So, the best way to capture a large machine state is to run your own local server and use
                 * server-side storage.  Take a look at the "Save" binding in computer.js, which binds an HTML
                 * control to the computer.powerOff() and computer.saveServerState() functions.
                 */
                console.log(s);
            } else {
                this.doClear();
                this.println(s);
            }
            return;
        }

        if (sAddr == "symbols") {
            this.dumpSymbols();
            return;
        }

        if (sCmd == "dos") {
            /*
             * The "dos" command is an undocumented command that's useful any time we're inside an internal
             * DOS dispatch function where the registers are substantially the same as the corresponding INT 0x21;
             * "m int on; m dos on" produces the same output, but only when an actual INT 0x21 instruction is used.
             * Issuing this command at any other time should also be OK, but the results will be meaningless.
             *
             * NOTE: This is different from the "d dos" command, which invokes dumpDos() to dump DOS memory blocks,
             * and is handled by one of the registered dumper functions below.
             */
            this.messageInt(Interrupts.DOS, this.cpu.regLIP, true);
            return;
        }

        if (sCmd == "ds") {                     // transform a "ds" command into a "d desc" command
            sCmd = 'd';
            asArgs = [sCmd, "desc", sAddr];
        }

        if (sCmd == 'd') {
            for (m in Debugger.MESSAGES) {
                if (sAddr == m) {
                    var fnDumper = this.afnDumpers[m];
                    if (fnDumper) {
                        asArgs.shift();
                        asArgs.shift();
                        fnDumper(asArgs);
                    } else {
                        this.println("no dump registered for " + sAddr);
                    }
                    return;
                }
            }
            sCmd = this.sCmdDumpPrev || "db";
        } else {
            this.sCmdDumpPrev = sCmd;
        }

        if (sCmd == "dh") {
            this.dumpHistory(sAddr, sLen);
            return;
        }

        if (sCmd == "di") {
            asArgs.shift();
            var sInfo = this.dumpInfo(asArgs);
            this.println(sInfo);
            return;
        }

        var dbgAddr = this.parseAddr(sAddr, Debugger.ADDR.DATA);
        if (!dbgAddr || dbgAddr.sel == null && dbgAddr.addr == null) return;

        var cb = 0;                             // 0 is not a default; it triggers the appropriate default below
        if (sLen) {
            if (sLen.charAt(0) == 'l') {
                sLen = sLen.substr(1) || sBytes;
            }
            cb = this.parseValue(sLen) >>> 0;   // negative lengths not allowed
            if (cb > 0x10000) cb = 0x10000;     // prevent bad user (or register) input from producing excessive output
        }

        var sDump = "";
        var cLines = (((cb || 128) + 15) >> 4) || 1;
        var size = (sCmd == "dd"? 4 : (sCmd == "dw"? 2 : 1));
        for (var iLine = 0; iLine < cLines; iLine++) {
            var data = 0, iByte = 0;
            var sData = "", sChars = "";
            sAddr = this.hexAddr(dbgAddr);
            for (var i = 0; i < 16; i++) {
                var b = this.getByte(dbgAddr, 1);
                data |= (b << (iByte++ << 3));
                if (iByte == size) {
                    sData += str.toHex(data, size * 2);
                    sData += (size == 1? (i == 7? '-' : ' ') : "  ");
                    data = iByte = 0;
                }
                sChars += (b >= 32 && b < 128? String.fromCharCode(b) : '.');
            }
            if (sDump) sDump += '\n';
            sDump += sAddr + "  " + sData + ' ' + sChars;
        }

        if (sDump) this.println(sDump);
        this.dbgAddrNextData = dbgAddr;
    };

    /**
     * doEdit(asArgs)
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs
     */
    Debugger.prototype.doEdit = function(asArgs)
    {
        var size = 1;
        var mask = 0xff;
        var fnGet = this.getByte;
        var fnSet = this.setByte;
        if (asArgs[0] == "ew") {
            size = 2;
            mask = 0xffff;
            fnGet = this.getShort;
            fnSet = this.setShort;
        }
        var cch = size << 1;

        var sAddr = asArgs[1];
        if (sAddr == null) {
            this.println("edit memory commands:");
            this.println("\teb [a] [...]  edit bytes at address a");
            this.println("\tew [a] [...]  edit words at address a");
            return;
        }

        var dbgAddr = this.parseAddr(sAddr, Debugger.ADDR.DATA);
        if (!dbgAddr) return;

        for (var i = 2; i < asArgs.length; i++) {
            var vNew = this.parseExpression(asArgs[i]);
            if (vNew === undefined) {
                this.println("unrecognized value: " + asArgs[i]);
                break;
            }
            if (vNew & ~mask) {
                this.println("warning: " + str.toHex(vNew) + " exceeds " + size + "-byte value");
            }
            var vOld = fnGet.call(this, dbgAddr);
            this.println("changing " + this.hexAddr(dbgAddr) + " from 0x" + str.toHex(vOld, cch) + " to 0x" + str.toHex(vNew, cch));
            fnSet.call(this, dbgAddr, vNew, size);
        }
    };

    /**
     * doFreqs(sParm)
     *
     * @this {Debugger}
     * @param {string|undefined} sParm
     */
    Debugger.prototype.doFreqs = function(sParm)
    {
        if (sParm == '?') {
            this.println("frequency commands:");
            this.println("\tclear\tclear all frequency counts");
            return;
        }
        var i;
        var cData = 0;
        if (this.aaOpcodeCounts) {
            if (sParm == "clear") {
                for (i = 0; i < this.aaOpcodeCounts.length; i++)
                    this.aaOpcodeCounts[i] = [i, 0];
                this.println("frequency data cleared");
                cData++;
            }
            else if (sParm !== undefined) {
                this.println("unknown frequency command: " + sParm);
                cData++;
            }
            else {
                var aaSortedOpcodeCounts = this.aaOpcodeCounts.slice();
                aaSortedOpcodeCounts.sort(function(p, q) {
                    return q[1] - p[1];
                });
                for (i = 0; i < aaSortedOpcodeCounts.length; i++) {
                    var bOpcode = aaSortedOpcodeCounts[i][0];
                    var cFreq = aaSortedOpcodeCounts[i][1];
                    if (cFreq) {
                        this.println((Debugger.INS_NAMES[this.aaOpDescs[bOpcode][0]] + "  ").substr(0, 5) + " (" + str.toHexByte(bOpcode) + "): " + cFreq + " times");
                        cData++;
                    }
                }
            }
        }
        if (!cData) {
            this.println("no frequency data available");
        }
    };

    /**
     * doHalt(fQuiet)
     *
     * @this {Debugger}
     * @param {boolean} [fQuiet]
     */
    Debugger.prototype.doHalt = function(fQuiet)
    {
        var sMsg;
        if (this.aFlags.fRunning) {
            sMsg = "halting";
            this.stopCPU();
        } else {
            sMsg = "already halted";
        }
        if (!fQuiet) this.println(sMsg);
    };

    /**
     * doIf(sCmd, fQuiet)
     *
     * NOTE: Don't forget that the default base for all numeric constants is 16, so when you evaluate an
     * expression like "a==10", it will compare the value of the variable "a" to 0x10; use a trailing period
     * (eg, "10.") if you really intend decimal.
     *
     * Also, if no variable named "a" exists, "a" will evaluate to 0x0A, so the expression "a==10" becomes
     * "0x0A==0x10" (false), whereas the expression "a==10." becomes "0x0A==0x0A" (true).
     *
     * @this {Debugger}
     * @param {string} sCmd
     * @param {boolean} [fQuiet]
     * @return {boolean} true if expression is non-zero, false if zero (or undefined due to a parse error)
     */
    Debugger.prototype.doIf = function(sCmd, fQuiet)
    {
        sCmd = str.trim(sCmd);
        if (!this.parseExpression(sCmd)) {
            if (!fQuiet) this.println("false: " + sCmd);
            return false;
        }
        if (!fQuiet) this.println("true: " + sCmd);
        return true;
    };

    /**
     * doInfo(asArgs)
     *
     * Prints the contents of the Debugger's instruction trace buffer.
     *
     * Examples:
     *
     *      n shl
     *      n shl on
     *      n shl off
     *      n dump 100
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs
     * @return {boolean} true only if the instruction info command ("n") is supported
     */
    Debugger.prototype.doInfo = function(asArgs)
    {
        if (DEBUG) {
            var sCategory = asArgs[1];
            if (sCategory !== undefined) {
                sCategory = sCategory.toUpperCase();
            }
            var sEnable = asArgs[2];
            var fPrint = false;
            if (sCategory == "DUMP") {
                var sDump = "";
                var cLines = (sEnable === undefined? -1 : +sEnable);    // warning: decimal instead of hex conversion
                var i = this.iTraceBuffer;
                do {
                    var s = this.aTraceBuffer[i++];
                    if (s !== undefined) {
                        /*
                         * The browser is MUCH happier if we buffer all the lines for one single enormous print
                         *
                         *      this.println(s);
                         */
                        sDump += (sDump? '\n' : "") + s;
                        cLines--;
                    }
                    if (i >= this.aTraceBuffer.length)
                        i = 0;
                } while (cLines && i != this.iTraceBuffer);
                if (!sDump) sDump = "nothing to dump";
                this.println(sDump);
                this.println("msPerYield: " + this.cpu.aCounts.msPerYield);
                this.println("nCyclesPerBurst: " + this.cpu.aCounts.nCyclesPerBurst);
                this.println("nCyclesPerYield: " + this.cpu.aCounts.nCyclesPerYield);
                this.println("nCyclesPerVideoUpdate: " + this.cpu.aCounts.nCyclesPerVideoUpdate);
                this.println("nCyclesPerStatusUpdate: " + this.cpu.aCounts.nCyclesPerStatusUpdate);
            } else {
                var fEnable = (sEnable == "on");
                for (var prop in this.traceEnabled) {
                    var trace = Debugger.TRACE[prop];
                    if (sCategory === undefined || sCategory == "ALL" || sCategory == Debugger.INS_NAMES[trace.ins]) {
                        if (fEnable !== undefined) {
                            this.traceEnabled[prop] = fEnable;
                        }
                        this.println(Debugger.INS_NAMES[trace.ins] + trace.size + ": " + (this.traceEnabled[prop]? "on" : "off"));
                        fPrint = true;
                    }
                }
                if (!fPrint) this.println("no match");
            }
            return true;
        }
        return false;
    };

    /**
     * doInput(sPort)
     *
     * @this {Debugger}
     * @param {string|undefined} sPort
     */
    Debugger.prototype.doInput = function(sPort)
    {
        if (!sPort || sPort == '?') {
            this.println("input commands:");
            this.println("\ti [p]\tread port [p]");
            /*
             * TODO: Regarding this warning, consider adding an "unchecked" version of
             * bus.checkPortInputNotify(), since all Debugger memory accesses are unchecked, too.
             *
             * All port I/O handlers ARE aware when the Debugger is calling (addrFrom is undefined),
             * but changing them all to be non-destructive would take time, and situations where you
             * actually want to affect the hardware state are just as likely as not....
             */
            this.println("warning: port accesses can affect hardware state");
            return;
        }
        var port = this.parseValue(sPort);
        if (port !== undefined) {
            var bIn = this.bus.checkPortInputNotify(port);
            this.println(str.toHexWord(port) + ": " + str.toHexByte(bIn));
        }
    };

    /**
     * doLet(sCmd)
     *
     * The command must be of the form "{variable} = [{expression}]", where expression may contain constants,
     * operators, registers, symbols, other variables, or nothing at all; in the latter case, the variable, if
     * any, is deleted.
     *
     * Other supported shorthand: "let" with no parameters prints the values of all variables, and "let {variable}"
     * prints the value of the specified variable.
     *
     * @this {Debugger}
     * @param {string} sCmd
     * @return {boolean} true if valid "let" assignment, false if not
     */
    Debugger.prototype.doLet = function(sCmd)
    {
        var a = sCmd.match(/^\s*([A-Z_]?[A-Z0-9_]*)\s*(=?)\s*(.*)$/i);
        if (a) {
            if (!a[1]) {
                if (!this.printVariable()) this.println("no variables");
                return true;    // it's not considered an error to print an empty list of variables
            }
            if (!a[2]) {
                return this.printVariable(a[1]);
            }
            if (!a[3]) {
                this.delVariable(a[1]);
                return true;    // it's not considered an error to delete a variable that didn't exist
            }
            var v = this.parseExpression(a[3]);
            if (v !== undefined) {
                this.setVariable(a[1], v);
                return true;
            }
            return false;
        }
        this.println("invalid assignment:" + sCmd);
        return false;
    };

    /**
     * doList(sSymbol)
     *
     * @this {Debugger}
     * @param {string} sSymbol
     */
    Debugger.prototype.doList = function(sSymbol)
    {
        var dbgAddr = this.parseAddr(sSymbol, Debugger.ADDR.CODE);
        if (!dbgAddr) return;

        var addr = this.getAddr(dbgAddr);
        sSymbol = sSymbol? (sSymbol + ": ") : "";
        this.println(sSymbol + this.hexAddr(dbgAddr) + " (%" + str.toHex(addr, this.cchAddr) + ')');

        var aSymbol = this.findSymbol(dbgAddr, true);
        if (aSymbol.length) {
            var nDelta, sDelta;
            if (aSymbol[0]) {
                sDelta = "";
                nDelta = dbgAddr.off - aSymbol[1];
                if (nDelta) sDelta = " + " + str.toHexWord(nDelta);
                this.println(aSymbol[0] + " (" + this.hexOffset(aSymbol[1], dbgAddr.sel) + ')' + sDelta);
            }
            if (aSymbol.length > 4 && aSymbol[4]) {
                sDelta = "";
                nDelta = aSymbol[5] - dbgAddr.off;
                if (nDelta) sDelta = " - " + str.toHexWord(nDelta);
                this.println(aSymbol[4] + " (" + this.hexOffset(aSymbol[5], dbgAddr.sel) + ')' + sDelta);
            }
        } else {
            this.println("no symbols");
        }
    };

    /**
     * doLoad(asArgs)
     *
     * The format of this command mirrors the DOS DEBUG "L" command:
     *
     *      l [address] [drive #] [sector #] [# sectors]
     *
     * The only optional parameter is the last, which defaults to 1 sector if not specified.
     *
     * As a quick-and-dirty way of getting the current contents of a disk image as a JSON dump
     * (which you can then save as .json disk image file), I also allow this command format:
     *
     *      l json [drive #]
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs
     */
    Debugger.prototype.doLoad = function(asArgs)
    {
        if (!asArgs[1] || asArgs[1] == '?') {
            this.println("list/load commands:");
            this.println("\tl [address] [drive #] [sector #] [# sectors]");
            this.println("\tln [address] lists symbol(s) nearest to address");
            return;
        }

        if (asArgs[0] == "ln") {
            this.doList(asArgs[1]);
            return;
        }

        var fJSON = (asArgs[1] == "json");
        var iDrive, iSector = 0, nSectors = 0;

        var dbgAddr = (fJSON? {} : this.parseAddr(asArgs[1], Debugger.ADDR.DATA));
        if (!dbgAddr) return;

        iDrive = this.parseValue(asArgs[2], "drive #");
        if (iDrive === undefined) return;
        if (!fJSON) {
            iSector = this.parseValue(asArgs[3], "sector #");
            if (iSector === undefined) return;
            nSectors = this.parseValue(asArgs[4], "# of sectors");
            if (nSectors === undefined) nSectors = 1;
        }

        /*
         * We choose the disk controller very simplistically: FDC for drives 0 or 1, and HDC for drives 2
         * and up, unless no HDC is present, in which case we assume FDC for all drive numbers.
         *
         * Both controllers must obviously support the same interfaces; ie, copyDrive(), seekDrive(),
         * and readByte().  We also rely on the disk property to determine whether the drive is "loaded".
         *
         * In the case of the HDC, if the drive is valid, then by definition it is also "loaded", since an HDC
         * drive and its disk are inseparable; it's certainly possible that the disk object may be empty at
         * this point (ie, if the disk is uninitialized and unformatted), but that will only affect whether the
         * read succeeds or not.
         */
        var dc = this.fdc;
        if (iDrive >= 2 && this.hdc) {
            iDrive -= 2;
            dc = this.hdc;
        }
        if (dc) {
            var drive = dc.copyDrive(iDrive);
            if (drive) {
                if (drive.disk) {
                    if (fJSON) {
                        /*
                         * This is an interim solution to dumping disk images in JSON.  It has many problems, the
                         * "biggest" being that the large disk images really need to be compressed first, because they
                         * get "inflated" with use.  See the dump() method in the Disk component for more details.
                         */
                        this.doClear();
                        this.println(drive.disk.toJSON());
                        return;
                    }
                    if (dc.seekDrive(drive, iSector, nSectors)) {
                        var cb = 0;
                        var fAbort = false;
                        var sAddr = this.hexAddr(dbgAddr);
                        while (!fAbort && drive.nBytes-- > 0) {
                            (function(dbg, dbgAddrCur) {
                                dc.readByte(drive, function(b, fAsync) {
                                    if (b < 0) {
                                        dbg.println("out of data at address " + dbg.hexAddr(dbgAddrCur));
                                        fAbort = true;
                                        return;
                                    }
                                    dbg.setByte(dbgAddrCur, b, 1);
                                    cb++;
                                });
                            }(this, dbgAddr));
                        }
                        this.println(cb + " bytes read at " + sAddr);
                    } else {
                        this.println("sector " + iSector + " request out of range");
                    }
                } else {
                    this.println("drive " + iDrive + " not loaded");
                }
            } else {
                this.println("invalid drive: " + iDrive);
            }
        } else {
            this.println("disk controller not present");
        }
    };

    /**
     * doMessages(asArgs)
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs
     */
    Debugger.prototype.doMessages = function(asArgs)
    {
        var m;
        var fCriteria = null;
        var sCategory = asArgs[1];
        if (sCategory == '?') sCategory = undefined;

        if (sCategory !== undefined) {
            var bitsMessage = 0;
            if (sCategory == "all") {
                bitsMessage = (0xffffffff|0) & ~(Messages.HALT | Messages.KEYS | Messages.LOG);
                sCategory = null;
            } else if (sCategory == "on") {
                fCriteria = true;
                sCategory = null;
            } else if (sCategory == "off") {
                fCriteria = false;
                sCategory = null;
            } else {
                /*
                 * Internally, we use "key" instead of "keys", since the latter is a method on JavasScript objects,
                 * but externally, we allow the user to specify "keys"; "kbd" is also allowed as shorthand for "keyboard".
                 */
                if (sCategory == "keys") sCategory = "key";
                if (sCategory == "kbd") sCategory = "keyboard";
                for (m in Debugger.MESSAGES) {
                    if (sCategory == m) {
                        bitsMessage = Debugger.MESSAGES[m];
                        fCriteria = !!(this.bitsMessage & bitsMessage);
                        break;
                    }
                }
                if (!bitsMessage) {
                    this.println("unknown message category: " + sCategory);
                    return;
                }
            }
            if (bitsMessage) {
                if (asArgs[2] == "on") {
                    this.bitsMessage |= bitsMessage;
                    fCriteria = true;
                }
                else if (asArgs[2] == "off") {
                    this.bitsMessage &= ~bitsMessage;
                    fCriteria = false;
                }
            }
        }

        /*
         * Display those message categories that match the current criteria (on or off)
         */
        var n = 0;
        var sCategories = "";
        for (m in Debugger.MESSAGES) {
            if (!sCategory || sCategory == m) {
                var bitMessage = Debugger.MESSAGES[m];
                var fEnabled = !!(this.bitsMessage & bitMessage);
                if (fCriteria !== null && fCriteria != fEnabled) continue;
                if (sCategories) sCategories += ',';
                if (!(++n % 10)) sCategories += "\n\t";     // jshint ignore:line
                /*
                 * Internally, we use "key" instead of "keys", since the latter is a method on JavasScript objects,
                 * but externally, we allow the user to specify "keys".
                 */
                if (m == "key") m = "keys";
                sCategories += m;
            }
        }

        if (sCategory === undefined) {
            this.println("message commands:\n\tm [category] [on|off]\tturn categories on/off");
        }

        this.println((fCriteria !== null? (fCriteria? "messages on:  " : "messages off: ") : "message categories:\n\t") + (sCategories || "none"));

        this.historyInit();     // call this just in case Messages.INT was turned on
    };

    /**
     * doMouse(sAction, sDelta)
     *
     * When using the "click" action, specify 0 for Mouse.BUTTON.LEFT or 2 for Mouse.BUTTON.RIGHT.
     *
     * @this {Debugger}
     * @param {string} sAction
     * @param {string} sDelta
     */
    Debugger.prototype.doMouse = function(sAction, sDelta)
    {
        if (this.mouse) {
            var xDelta = 0, yDelta = 0;
            var sign = 1;
            if (sDelta.charAt(0) == '-') {
                sign = -1;
                sDelta = sDelta.substr(1);
            }
            var n = this.parseValue(sDelta, sAction);
            if (n === undefined) return;
            n = (n * sign)|0;
            switch(sAction) {
            case "x":
                this.mouse.moveMouse(n, 0);
                break;
            case "y":
                this.mouse.moveMouse(0, n);
                break;
            case "click":
                this.mouse.clickMouse(n, true);
                this.mouse.clickMouse(n, false);
                break;
            default:
                this.println("unknown action: " + sAction);
                break;
            }
            return;
        }
        this.println("no mouse");
    };

    /**
     * doExecOptions(asArgs)
     *
     * @this {Debugger}
     * @param {Array.<string>} asArgs
     */
    Debugger.prototype.doExecOptions = function(asArgs)
    {
        if (!asArgs[1] || asArgs[1] == '?') {
            this.println("execution options:");
            this.println("\tcs int #\tset checksum cycle interval to #");
            this.println("\tcs start #\tset checksum cycle start count to #");
            this.println("\tcs stop #\tset checksum cycle stop count to #");
            this.println("\tsp #\t\tset speed multiplier to #");
            return;
        }
        switch (asArgs[1]) {
        case "cs":
            var nCycles;
            if (asArgs[3] !== undefined) nCycles = +asArgs[3];          // warning: decimal instead of hex conversion
            switch (asArgs[2]) {
                case "int":
                    this.cpu.aCounts.nCyclesChecksumInterval = nCycles;
                    break;
                case "start":
                    this.cpu.aCounts.nCyclesChecksumStart = nCycles;
                    break;
                case "stop":
                    this.cpu.aCounts.nCyclesChecksumStop = nCycles;
                    break;
                default:
                    this.println("unknown cs option");
                    return;
            }
            if (nCycles !== undefined) {
                this.cpu.resetChecksum();
            }
            this.println("checksums " + (this.cpu.aFlags.fChecksum? "enabled" : "disabled"));
            break;
        case "sp":
            if (asArgs[2] !== undefined) {
                if (!this.cpu.setSpeed(+asArgs[2])) {
                    this.println("warning: using 1x multiplier, previous target not reached");
                }
            }
            this.println("target speed: " + this.cpu.getSpeedTarget() + " (" + this.cpu.getSpeed() + "x)");
            break;
        default:
            this.println("unknown option: " + asArgs[1]);
            break;
        }
    };

    /**
     * doOutput(sPort, sByte)
     *
     * @this {Debugger}
     * @param {string|undefined} sPort
     * @param {string|undefined} sByte (string representation of 1 byte)
     */
    Debugger.prototype.doOutput = function(sPort, sByte)
    {
        if (!sPort || sPort == '?') {
            this.println("output commands:");
            this.println("\to [p] [b]\twrite byte [b] to port [p]");
            /*
             * TODO: Regarding this warning, consider adding an "unchecked" version of
             * bus.checkPortOutputNotify(), since all Debugger memory accesses are unchecked, too.
             *
             * All port I/O handlers ARE aware when the Debugger is calling (addrFrom is undefined),
             * but changing them all to be non-destructive would take time, and situations where you
             * actually want to affect the hardware state are just as likely as not....
             */
            this.println("warning: port accesses can affect hardware state");
            return;
        }
        var port = this.parseValue(sPort, "port #");
        var bOut = this.parseValue(sByte);
        if (port !== undefined && bOut !== undefined) {
            this.bus.checkPortOutputNotify(port, bOut);
            this.println(str.toHexWord(port) + ": " + str.toHexByte(bOut));
        }
    };

    /**
     * shiftArgs(asArgs)
     *
     * @this {Debugger}
     * @param {Array.<string>} [asArgs]
     */
    Debugger.prototype.shiftArgs = function(asArgs)
    {
        if (asArgs && asArgs.length) {
            var s0 = asArgs[0];
            var ch0 = s0.charAt(0);
            for (var i = 1; i < s0.length; i++) {
                var ch = s0.charAt(i);
                if (ch0 == '?' || ch0 == 'r' || ch < 'a' || ch > 'z') {
                    asArgs[0] = s0.substr(i);
                    asArgs.unshift(s0.substr(0, i));
                    break;
                }
            }
        }
    };

    /**
     * doRegisters(asArgs, fInstruction)
     *
     * @this {Debugger}
     * @param {Array.<string>} [asArgs]
     * @param {boolean} [fInstruction] (default is true)
     */
    Debugger.prototype.doRegisters = function(asArgs, fInstruction)
    {
        if (asArgs && asArgs[1] == '?') {
            this.println("register commands:");
            this.println("\tr\tdump registers");
            this.println("\trp\tdump all registers");
            this.println("\trx [#]\tset flag or register x to [#]");
            return;
        }

        var fProt;
        if (fInstruction == null) fInstruction = true;

        if (asArgs != null && asArgs.length > 1) {
            var sReg = asArgs[1];
            if (sReg == 'p') {
                fProt = (this.cpu.model >= X86.MODEL_80286);
            } else {
             // fInstruction = false;
                var sValue = null;
                var i = sReg.indexOf('=');
                if (i > 0) {
                    sValue = sReg.substr(i + 1);
                    sReg = sReg.substr(0, i);
                }
                else if (asArgs.length > 2) {
                    sValue = asArgs[2];
                }
                else {
                    this.println("missing value for " + asArgs[1]);
                    return;
                }
                var fValid = false;
                var w = this.parseExpression(sValue);
                if (w !== undefined) {
                    fValid = true;
                    var sRegMatch = sReg.toUpperCase();
                    if (sRegMatch.charAt(0) == 'E' && this.cchReg <= 4) {
                        sRegMatch = null;
                    }
                    switch (sRegMatch) {
                    case "AL":
                        this.cpu.regEAX = (this.cpu.regEAX & ~0xff) | (w & 0xff);
                        break;
                    case "AH":
                        this.cpu.regEAX = (this.cpu.regEAX & ~0xff00) | ((w << 8) & 0xff);
                        break;
                    case "AX":
                        this.cpu.regEAX = (this.cpu.regEAX & ~0xffff) | (w & 0xffff);
                        break;
                    case "BL":
                        this.cpu.regEBX = (this.cpu.regEBX & ~0xff) | (w & 0xff);
                        break;
                    case "BH":
                        this.cpu.regEBX = (this.cpu.regEBX & ~0xff00) | ((w << 8) & 0xff);
                        break;
                    case "BX":
                        this.cpu.regEBX = (this.cpu.regEBX & ~0xffff) | (w & 0xffff);
                        break;
                    case "CL":
                        this.cpu.regECX = (this.cpu.regECX & ~0xff) | (w & 0xff);
                        break;
                    case "CH":
                        this.cpu.regECX = (this.cpu.regECX & ~0xff00) | ((w << 8) & 0xff);
                        break;
                    case "CX":
                        this.cpu.regECX = (this.cpu.regECX & ~0xffff) | (w & 0xffff);
                        break;
                    case "DL":
                        this.cpu.regEDX = (this.cpu.regEDX & ~0xff) | (w & 0xff);
                        break;
                    case "DH":
                        this.cpu.regEDX = (this.cpu.regEDX & ~0xff00) | ((w << 8) & 0xff);
                        break;
                    case "DX":
                        this.cpu.regEDX = (this.cpu.regEDX & ~0xffff) | (w & 0xffff);
                        break;
                    case "SP":
                        this.cpu.setSP((this.cpu.getSP() & ~0xffff) | (w & 0xffff));
                        break;
                    case "BP":
                        this.cpu.regEBP = (this.cpu.regEBP & ~0xffff) | (w & 0xffff);
                        break;
                    case "SI":
                        this.cpu.regESI = (this.cpu.regESI & ~0xffff) | (w & 0xffff);
                        break;
                    case "DI":
                        this.cpu.regEDI = (this.cpu.regEDI & ~0xffff) | (w & 0xffff);
                        break;
                    /*
                     * DANGER: For any of the segment loads below, by going through the normal CPU
                     * segment load procedure, you run the risk of generating a fault in the machine
                     * if you're not careful.  So, um, be careful.
                     */
                    case "DS":
                        this.cpu.setDS(w);
                        break;
                    case "ES":
                        this.cpu.setES(w);
                        break;
                    case "SS":
                        this.cpu.setSS(w);
                        break;
                    case "CS":
                     // fInstruction = true;
                        this.cpu.setCS(w);
                        this.dbgAddrNextCode = this.newAddr(this.cpu.getIP(), this.cpu.getCS());
                        break;
                    case "IP":
                    case "EIP":
                     // fInstruction = true;
                        this.cpu.setIP(w);
                        this.dbgAddrNextCode = this.newAddr(this.cpu.getIP(), this.cpu.getCS());
                        break;
                    /*
                     * I used to alias "PC" to "IP", until I discovered that early (perhaps ALL) versions of
                     * DEBUG.COM treat "PC" as an alias for the 16-bit flags register.  I, of course, prefer "PS".
                     */
                    case "PC":
                    case "PS":
                        this.cpu.setPS(w);
                        break;
                    case 'C':
                        if (w) this.cpu.setCF(); else this.cpu.clearCF();
                        break;
                    case 'P':
                        if (w) this.cpu.setPF(); else this.cpu.clearPF();
                        break;
                    case 'A':
                        if (w) this.cpu.setAF(); else this.cpu.clearAF();
                        break;
                    case 'Z':
                        if (w) this.cpu.setZF(); else this.cpu.clearZF();
                        break;
                    case 'S':
                        if (w) this.cpu.setSF(); else this.cpu.clearSF();
                        break;
                    case 'I':
                        if (w) this.cpu.setIF(); else this.cpu.clearIF();
                        break;
                    case 'D':
                        if (w) this.cpu.setDF(); else this.cpu.clearDF();
                        break;
                    case 'V':
                        if (w) this.cpu.setOF(); else this.cpu.clearOF();
                        break;
                    default:
                        var fUnknown = true;
                        if (this.cpu.model >= X86.MODEL_80286) {
                            fUnknown = false;
                            switch(sRegMatch){
                            case "MS":
                                this.cpu.setMSW(w);
                                break;
                            case "TR":
                                /*
                                 * DANGER: Like any of the segment loads above, by going through the normal CPU
                                 * segment load procedure, you run the risk of generating a fault in the machine
                                 * if you're not careful.  So, um, be careful.
                                 */
                                if (this.cpu.segTSS.load(w) === X86.ADDR_INVALID) {
                                    fValid = false;
                                }
                                break;
                            /*
                             * TODO: Add support for GDTR (addr and limit), IDTR (addr and limit), and perhaps
                             * even the ability to edit descriptor information associated with each segment register.
                             */
                            default:
                                fUnknown = true;
                                if (I386 && this.cpu.model >= X86.MODEL_80386) {
                                    fUnknown = false;
                                    switch(sRegMatch){
                                    case "EAX":
                                        this.cpu.regEAX = w;
                                        break;
                                    case "EBX":
                                        this.cpu.regEBX = w;
                                        break;
                                    case "ECX":
                                        this.cpu.regECX = w;
                                        break;
                                    case "EDX":
                                        this.cpu.regEDX = w;
                                        break;
                                    case "ESP":
                                        this.cpu.setSP(w);
                                        break;
                                    case "EBP":
                                        this.cpu.regEBP = w;
                                        break;
                                    case "ESI":
                                        this.cpu.regESI = w;
                                        break;
                                    case "EDI":
                                        this.cpu.regEDI = w;
                                        break;
                                    /*
                                     * DANGER: For any of the segment loads below, by going through the normal CPU
                                     * segment load procedure, you run the risk of generating a fault in the machine
                                     * if you're not careful.  So, um, be careful.
                                     */
                                    case "FS":
                                        this.cpu.setFS(w);
                                        break;
                                    case "GS":
                                        this.cpu.setGS(w);
                                        break;
                                    case "CR0":
                                        this.cpu.regCR0 = w;
                                        X86.fnLCR0.call(this.cpu, w);
                                        break;
                                    case "CR2":
                                        this.cpu.regCR2 = w;
                                        break;
                                    case "CR3":
                                        this.cpu.regCR3 = w;
                                        X86.fnLCR3.call(this.cpu, w);
                                        break;
                                    /*
                                     * TODO: Add support for DR0-DR7 and TR6-TR7.
                                     */
                                    default:
                                        fUnknown = true;
                                        break;
                                    }
                                }
                                break;
                            }
                        }
                        if (fUnknown) {
                            this.println("unknown register: " + sReg);
                            return;
                        }
                    }
                }
                if (!fValid) {
                    this.println("invalid value: " + sValue);
                    return;
                }
                this.cpu.updateCPU();
                this.println("updated registers:");
            }
        }

        this.println(this.getRegDump(fProt));

        if (fInstruction) {
            this.dbgAddrNextCode = this.newAddr(this.cpu.getIP(), this.cpu.getCS());
            this.doUnassemble(this.hexAddr(this.dbgAddrNextCode));
        }
    };

    /**
     * doRun(sAddr, sOptions, fQuiet)
     *
     * @this {Debugger}
     * @param {string} sAddr
     * @param {string} [sOptions]
     * @param {boolean} [fQuiet]
     */
    Debugger.prototype.doRun = function(sAddr, sOptions, fQuiet)
    {
        if (sAddr !== undefined) {
            var dbgAddr = this.parseAddr(this.parseReference(sAddr), Debugger.ADDR.CODE);
            if (!dbgAddr) return;
            this.parseAddrOptions(dbgAddr, sOptions);
            this.setTempBreakpoint(dbgAddr);
        }
        if (!this.runCPU(true)) {
            if (!fQuiet) this.println("cpu busy or unavailable, run command ignored");
        }
    };

    /**
     * doPrint(sCmd)
     *
     * If the string to print is a quoted string, then we run it through replaceRegs(), so that
     * you can take advantage of all the special replacement options used for software interrupt logging.
     *
     * @this {Debugger}
     * @param {string} sCmd
     */
    Debugger.prototype.doPrint = function(sCmd)
    {
        sCmd = str.trim(sCmd);
        var a = sCmd.match(/^(['"])(.*?)\1$/);
        if (a) {
            this.println(this.replaceRegs(a[2]));
        } else {
            this.parseExpression(sCmd, true);
        }
    };

    /**
     * doStep(sCmd)
     *
     * @this {Debugger}
     * @param {string} [sCmd] "p" or "pr"
     */
    Debugger.prototype.doStep = function(sCmd)
    {
        var fCallStep = true;
        var fRegs = (sCmd == "pr"? 1 : 0);
        /*
         * Set up the value for this.nStep (ie, 1 or 2) depending on whether the user wants
         * a subsequent register dump ("pr") or not ("p").
         */
        var nStep = 1 + fRegs;
        if (!this.nStep) {
            var fPrefix;
            var fRepeat = false;
            var dbgAddr = this.newAddr(this.cpu.getIP(), this.cpu.getCS());
            do {
                fPrefix = false;
                var bOpcode = this.getByte(dbgAddr);
                switch (bOpcode) {
                case X86.OPCODE.ES:
                case X86.OPCODE.CS:
                case X86.OPCODE.SS:
                case X86.OPCODE.DS:
                case X86.OPCODE.FS:     // I386 only
                case X86.OPCODE.GS:     // I386 only
                case X86.OPCODE.OS:     // I386 only
                case X86.OPCODE.AS:     // I386 only
                case X86.OPCODE.LOCK:
                    this.incAddr(dbgAddr, 1);
                    fPrefix = true;
                    break;
                case X86.OPCODE.INT3:
                case X86.OPCODE.INTO:
                    this.nStep = nStep;
                    this.incAddr(dbgAddr, 1);
                    break;
                case X86.OPCODE.INTN:
                case X86.OPCODE.LOOPNZ:
                case X86.OPCODE.LOOPZ:
                case X86.OPCODE.LOOP:
                    this.nStep = nStep;
                    this.incAddr(dbgAddr, 2);
                    break;
                case X86.OPCODE.CALL:
                    if (fCallStep) {
                        this.nStep = nStep;
                        this.incAddr(dbgAddr, 3);
                    }
                    break;
                case X86.OPCODE.CALLF:
                    if (fCallStep) {
                        this.nStep = nStep;
                        this.incAddr(dbgAddr, 5);
                    }
                    break;
                case X86.OPCODE.GRP4W:
                    if (fCallStep) {
                        var w = this.getWord(dbgAddr) & X86.OPCODE.CALLMASK;
                        if (w == X86.OPCODE.CALLW || w == X86.OPCODE.CALLFDW) {
                            this.nStep = nStep;
                            this.getInstruction(dbgAddr);       // advance dbgAddr past this variable-length CALL
                        }
                    }
                    break;
                case X86.OPCODE.REPZ:
                case X86.OPCODE.REPNZ:
                    this.incAddr(dbgAddr, 1);
                    fRepeat = fPrefix = true;
                    break;
                case X86.OPCODE.INSB:
                case X86.OPCODE.INSW:
                case X86.OPCODE.OUTSB:
                case X86.OPCODE.OUTSW:
                case X86.OPCODE.MOVSB:
                case X86.OPCODE.MOVSW:
                case X86.OPCODE.CMPSB:
                case X86.OPCODE.CMPSW:
                case X86.OPCODE.STOSB:
                case X86.OPCODE.STOSW:
                case X86.OPCODE.LODSB:
                case X86.OPCODE.LODSW:
                case X86.OPCODE.SCASB:
                case X86.OPCODE.SCASW:
                    if (fRepeat) {
                        this.nStep = nStep;
                        this.incAddr(dbgAddr, 1);
                    }
                    break;
                default:
                    break;
                }
            } while (fPrefix);

            if (this.nStep) {
                this.setTempBreakpoint(dbgAddr);
                if (!this.runCPU()) {
                    this.cpu.setFocus();
                    this.nStep = 0;
                }
                /*
                 * A successful run will ultimately call stop(), which will in turn call clearTempBreakpoint(),
                 * which will clear nStep, so there's your assurance that nStep will be reset.  Now we may
                 * have stopped for reasons unrelated to the temporary breakpoint, but that's OK.
                 */
            } else {
                this.doTrace(fRegs? "tr" : "t");
            }
        } else {
            this.println("step in progress");
        }
    };

    /**
     * getCall(dbgAddr, fFar)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {boolean} [fFar]
     * @return {string|null} CALL instruction at or near dbgAddr, or null if none
     */
    Debugger.prototype.getCall = function(dbgAddr, fFar)
    {
        var sCall = null;
        var off = dbgAddr.off;
        var offOrig = off;
        for (var n = 1; n <= 6 && !!off; n++) {
            if (n > 2) {
                dbgAddr.off = off;
                dbgAddr.addr = null;
                var s = this.getInstruction(dbgAddr);
                if (s.indexOf("CALL") > 0 || fFar && s.indexOf("INT") > 0) {
                    sCall = s;
                    break;
                }
            }
            off--;
        }
        dbgAddr.off = offOrig;
        return sCall;
    };

    /**
     * doStackTrace()
     *
     * @this {Debugger}
     */
    Debugger.prototype.doStackTrace = function()
    {
        var nFrames = 10, cFrames = 0;
        var selCode = this.cpu.segCS.sel;
        var dbgAddrCall = this.newAddr();
        var dbgAddrStack = this.newAddr(this.cpu.getSP(), this.cpu.getSS());
        this.println("stack trace for " + this.hexAddr(dbgAddrStack));
        while (cFrames < nFrames) {
            var sCall = null, cTests = 256;
            while ((dbgAddrStack.off >>> 0) < (this.cpu.regLSPLimit >>> 0)) {
                dbgAddrCall.off = this.getWord(dbgAddrStack, true);
                /*
                 * Because we're using the auto-increment feature of getWord(), and because that will automatically
                 * wrap the offset around the end of the segment, we must also check the addr property to detect the wrap.
                 */
                if (dbgAddrStack.addr == null || !cTests--) break;
                dbgAddrCall.sel = selCode;
                sCall = this.getCall(dbgAddrCall);
                if (sCall) {
                    break;
                }
                dbgAddrCall.sel = this.getWord(dbgAddrStack);
                sCall = this.getCall(dbgAddrCall, true);
                if (sCall) {
                    selCode = this.getWord(dbgAddrStack, true);
                    /*
                     * It's not strictly necessary that we skip over the flags word that's pushed as part of any INT
                     * instruction, but it reduces the risk of misinterpreting it as a return address on the next iteration.
                     */
                    if (sCall.indexOf("INT") > 0) this.getWord(dbgAddrStack, true);
                    break;
                }
            }
            if (!sCall) break;
            sCall = str.pad(sCall, 50) + "  ;stack=" + this.hexAddr(dbgAddrStack) + " return=" + this.hexAddr(dbgAddrCall);
            this.println(sCall);
            cFrames++;
        }
        if (!cFrames) this.println("no return addresses found");
    };

    /**
     * doTrace(sCmd, sCount)
     *
     * @this {Debugger}
     * @param {string} [sCmd] "t" or "tr"
     * @param {string} [sCount] # of instructions to step
     */
    Debugger.prototype.doTrace = function(sCmd, sCount)
    {
        var dbg = this;
        var fRegs = (sCmd == "tr");
        var count = this.parseValue(sCount, null, true) || 1;
        var nCycles = (count == 1? 0 : 1);
        web.onCountRepeat(
            count,
            function onCountStep() {
                return dbg.setBusy(true) && dbg.stepCPU(nCycles, fRegs, false);
            },
            function onCountStepComplete() {
                /*
                 * We explicitly called stepCPU() with fUpdateCPU === false, because repeatedly
                 * calling updateCPU() can be very slow, especially when fDisplayLiveRegs is true,
                 * so once the repeat count has been exhausted, we must perform a final updateCPU().
                 */
                dbg.cpu.updateCPU();
                dbg.setBusy(false);
            }
        );
    };

    /**
     * initAddrSize(dbgAddr, fComplete, cOverrides)
     *
     * @this {Debugger}
     * @param {DbgAddr} dbgAddr
     * @param {boolean} fComplete
     * @param {number} [cOverrides]
     */
    Debugger.prototype.initAddrSize = function(dbgAddr, fComplete, cOverrides)
    {
        /*
         * We use dbgAddr.fComplete to record whether or not the caller (ie, getInstruction())
         * processed a complete instruction.
         */
        dbgAddr.fComplete = fComplete;
        /*
         * For proper disassembly of instructions preceded by an OPERAND (0x66) size prefix, we set
         * dbgAddr.fData32 to true whenever the operand size is 32-bit; similarly, for an ADDRESS (0x67)
         * size prefix, we set dbgAddr.fAddr32 to true whenever the address size is 32-bit.
         *
         * Initially (and every time we've processed a complete instruction), both fields must be
         * set to their original value.
         */
        if (fComplete) {
            if (dbgAddr.fData32Orig != null) dbgAddr.fData32 = dbgAddr.fData32Orig;
            if (dbgAddr.fAddr32Orig != null) dbgAddr.fAddr32 = dbgAddr.fAddr32Orig;
            dbgAddr.fData32Orig = dbgAddr.fData32;
            dbgAddr.fAddr32Orig = dbgAddr.fAddr32;
        }
        /*
         * Use cOverrides to record whether we previously processed any OPERAND or ADDRESS overrides.
         */
        dbgAddr.cOverrides = cOverrides || 0;
    };

    /**
     * isStringIns(bOpcode)
     *
     * @this {Debugger}
     * @param {number} bOpcode
     * @return {boolean} true if string instruction, false if not
     */
    Debugger.prototype.isStringIns = function(bOpcode)
    {
        return (bOpcode >= X86.OPCODE.MOVSB && bOpcode <= X86.OPCODE.CMPSW || bOpcode >= X86.OPCODE.STOSB && bOpcode <= X86.OPCODE.SCASW);
    };

    /**
     * doUnassemble(sAddr, sAddrEnd, n)
     *
     * @this {Debugger}
     * @param {string} [sAddr]
     * @param {string} [sAddrEnd]
     * @param {number} [n]
     */
    Debugger.prototype.doUnassemble = function(sAddr, sAddrEnd, n)
    {
        var dbgAddr = this.parseAddr(sAddr, Debugger.ADDR.CODE);
        if (!dbgAddr) return;

        if (n === undefined) n = 1;

        var cb = 0x100;
        if (sAddrEnd !== undefined) {

            var dbgAddrEnd = this.parseAddr(sAddrEnd, Debugger.ADDR.CODE);
            if (!dbgAddrEnd || dbgAddrEnd.off < dbgAddr.off) return;

            cb = dbgAddrEnd.off - dbgAddr.off;
            if (!DEBUG && cb > 0x100) {
                /*
                 * Limiting the amount of disassembled code to 256 bytes in non-DEBUG builds is partly to
                 * prevent the user from wedging the browser by dumping too many lines, but also a recognition
                 * that, in non-DEBUG builds, this.println() keeps print output buffer truncated to 8Kb anyway.
                 */
                this.println("range too large");
                return;
            }
            n = -1;
        }

        var cLines = 0;
        this.initAddrSize(dbgAddr, true);

        while (cb > 0 && n--) {

            var bOpcode = this.getByte(dbgAddr);
            var addr = dbgAddr.addr;
            var nSequence = (this.isBusy(false) || this.nStep)? this.nCycles : null;
            var sComment = (nSequence != null? "cycles" : null);
            var aSymbol = this.findSymbol(dbgAddr);

            if (aSymbol[0] && n) {
                if (!cLines && n || aSymbol[0].indexOf('+') < 0) {
                    var sLabel = aSymbol[0] + ':';
                    if (aSymbol[2]) sLabel += ' ' + aSymbol[2];
                    this.println(sLabel);
                }
            }

            if (aSymbol[3]) {
                sComment = aSymbol[3];
                nSequence = null;
            }

            var sInstruction = this.getInstruction(dbgAddr, sComment, nSequence);

            /*
             * If getInstruction() reported that it did not process a complete instruction (via dbgAddr.fComplete),
             * then bump the instruction count by one, so that we display one more line (and hopefully the complete
             * instruction).
             */
            if (!dbgAddr.fComplete && !n) n++;

            this.println(sInstruction);
            this.dbgAddrNextCode = dbgAddr;
            cb -= dbgAddr.addr - addr;
            cLines++;
        }
    };

    /**
     * parseCommand(sCmd, fSave, chSep)
     *
     * @this {Debugger}
     * @param {string|undefined} sCmd
     * @param {boolean} [fSave] is true to save the command, false if not
     * @param {string} [chSep] is the command separator character (default is ';')
     * @return {Array.<string>}
     */
    Debugger.prototype.parseCommand = function(sCmd, fSave, chSep)
    {
        if (fSave) {
            if (!sCmd) {
                sCmd = this.aPrevCmds[this.iPrevCmd+1];
            } else {
                if (this.iPrevCmd < 0 && this.aPrevCmds.length) {
                    this.iPrevCmd = 0;
                }
                if (this.iPrevCmd < 0 || sCmd != this.aPrevCmds[this.iPrevCmd]) {
                    this.aPrevCmds.splice(0, 0, sCmd);
                    this.iPrevCmd = 0;
                }
                this.iPrevCmd--;
            }
        }
        var a = [];
        if (sCmd) {
            /*
             * With the introduction of breakpoint commands (ie, quoted command sequences
             * associated with a breakpoint), we can no longer perform simplistic splitting.
             *
             *      a = sCmd.split(chSep || ';');
             *      for (var i = 0; i < a.length; i++) a[i] = str.trim(a[i]);
             *
             * We may now split on semi-colons ONLY if they are outside a quoted sequence.
             *
             * Also, to allow quoted strings *inside* breakpoint commands, we first replace all
             * DOUBLE double-quotes with single quotes.
             */
            sCmd = sCmd.replace(/""/g, "'");

            var iPrev = 0;
            var chQuote = null;
            chSep = chSep || ';';
            /*
             * NOTE: Processing charAt() up to and INCLUDING length is not a typo; we're taking
             * advantage of the fact that charAt() with an invalid index returns an empty string,
             * allowing us to use the same substring() call to capture the final portion of sCmd.
             *
             * In a sense, it allows us to pretend that the string ends with a zero terminator.
             */
            for (var i = 0; i <= sCmd.length; i++) {
                var ch = sCmd.charAt(i);
                if (ch == '"' || ch == "'") {
                    if (!chQuote) {
                        chQuote = ch;
                    } else if (ch == chQuote) {
                        chQuote = null;
                    }
                }
                else if (ch == chSep && !chQuote || !ch) {
                    /*
                     * Recall that substring() accepts starting (inclusive) and ending (exclusive)
                     * indexes, whereas substr() accepts a starting index and a length.  We need the former.
                     */
                    a.push(str.trim(sCmd.substring(iPrev, i)));
                    iPrev = i + 1;
                }
            }
        }
        return a;
    };

    /**
     * doCommand(sCmd, fQuiet)
     *
     * @this {Debugger}
     * @param {string} sCmd
     * @param {boolean} [fQuiet]
     * @return {boolean} true if command processed, false if unrecognized
     */
    Debugger.prototype.doCommand = function(sCmd, fQuiet)
    {
        var result = true;

        try {
            if (!sCmd.length) {
                if (this.fAssemble) {
                    this.println("ended assemble @" + this.hexAddr(this.dbgAddrAssemble));
                    this.dbgAddrNextCode = this.dbgAddrAssemble;
                    this.fAssemble = false;
                } else {
                    sCmd = '?';
                }
            }
            else if (!fQuiet) {
                var sPrompt = ">> ";
                if (this.cpu.regCR0 & X86.CR0.MSW.PE) {
                    sPrompt = (this.cpu.regPS & X86.PS.VM)? "-- " : "## ";
                }
                this.println(sPrompt + sCmd);
            }

            var ch = sCmd.charAt(0);
            if (ch == '"' || ch == "'") return true;

            this.sMessagePrev = null;

            /*
             * I've relaxed the !isBusy() requirement, to maximize our ability to issue Debugger commands externally.
             */
            if (this.isReady() /* && !this.isBusy(true) */ && sCmd.length > 0) {

                if (this.fAssemble) {
                    sCmd = "a " + this.hexAddr(this.dbgAddrAssemble) + ' ' + sCmd;
                }

                var asArgs = sCmd.replace(/ +/g, ' ').split(' ');
                var ch0 = asArgs[0].charAt(0).toLowerCase();

                switch (ch0) {
                case 'a':
                    this.doAssemble(asArgs);
                    break;
                case 'b':
                    this.shiftArgs(asArgs);
                    this.doBreak(asArgs[0], asArgs[1], sCmd);
                    break;
                case 'c':
                    this.doClear(asArgs[0]);
                    break;
                case 'd':
                    if (!COMPILED && asArgs[0] == "debug") {
                        window.DEBUG = true;
                        this.println("DEBUG checks on");
                        break;
                    }
                    this.shiftArgs(asArgs);
                    this.doDump(asArgs);
                    break;
                case 'e':
                    if (asArgs[0] == "else") break;
                    this.doEdit(asArgs);
                    break;
                case 'f':
                    this.doFreqs(asArgs[1]);
                    break;
                case 'g':
                    this.doRun(asArgs[1], sCmd, fQuiet);
                    break;
                case 'h':
                    this.doHalt(fQuiet);
                    break;
                case 'i':
                    if (asArgs[0] == "if") {
                        if (!this.doIf(sCmd.substr(2), fQuiet)) {
                            result = false;
                        }
                        break;
                    }
                    this.doInput(asArgs[1]);
                    break;
                case 'k':
                    this.doStackTrace();
                    break;
                case 'l':
                    if (asArgs[0] == "let") {
                        if (!this.doLet(sCmd.substr(3))) {
                            result = false;
                        }
                        break;
                    }
                    this.shiftArgs(asArgs);
                    this.doLoad(asArgs);
                    break;
                case 'm':
                    if (asArgs[0] == "mouse") {
                        this.doMouse(asArgs[1], asArgs[2]);
                        break;
                    }
                    this.doMessages(asArgs);
                    break;
                case 'o':
                    this.doOutput(asArgs[1], asArgs[2]);
                    break;
                case 'p':
                    if (asArgs[0] == "print") {
                        this.doPrint(sCmd.substr(5));
                        break;
                    }
                    this.doStep(asArgs[0]);
                    break;
                case 'r':
                    if (asArgs[0] == "reset") {
                        if (this.cmp) this.cmp.reset();
                        break;
                    }
                    this.shiftArgs(asArgs);
                    this.doRegisters(asArgs);
                    break;
                case 't':
                    this.shiftArgs(asArgs);
                    this.doTrace(asArgs[0], asArgs[1]);
                    break;
                case 'u':
                    this.doUnassemble(asArgs[1], asArgs[2], 8);
                    break;
                case 'v':
                    this.println((APPNAME || "PCjs") + " version " + (XMLVERSION || APPVERSION) + " (" + this.cpu.model + (COMPILED? ",RELEASE" : (DEBUG? ",DEBUG" : ",NODEBUG")) + (PREFETCH? ",PREFETCH" : ",NOPREFETCH") + (TYPEDARRAYS? ",TYPEDARRAYS" : (FATARRAYS? ",FATARRAYS" : ",LONGARRAYS")) + (BACKTRACK? ",BACKTRACK" : ",NOBACKTRACK") + ')');
                    break;
                case 'x':
                    this.shiftArgs(asArgs);
                    this.doExecOptions(asArgs);
                    break;
                case '?':
                    this.shiftArgs(asArgs);
                    if (asArgs[1]) {
                        this.doPrint(sCmd.substr(1));
                        break;
                    }
                    this.doHelp();
                    break;
                case 'n':
                    if (!COMPILED && asArgs[0] == "nodebug") {
                        window.DEBUG = false;
                        this.println("DEBUG checks off");
                        break;
                    }
                    if (this.doInfo(asArgs)) break;
                    /* falls through */
                default:
                    this.println("unknown command: " + sCmd);
                    result = false;
                    break;
                }
            }
        } catch(e) {
            this.println("debugger error: " + (e.stack || e.message));
            result = false;
        }
        return result;
    };

    /**
     * Debugger.init()
     *
     * This function operates on every HTML element of class "debugger", extracting the
     * JSON-encoded parameters for the Debugger constructor from the element's "data-value"
     * attribute, invoking the constructor to create a Debugger component, and then binding
     * any associated HTML controls to the new component.
     */
    Debugger.init = function()
    {
        var aeDbg = Component.getElementsByClass(window.document, PCJSCLASS, "debugger");
        for (var iDbg = 0; iDbg < aeDbg.length; iDbg++) {
            var eDbg = aeDbg[iDbg];
            var parmsDbg = Component.getComponentParms(eDbg);
            var dbg = new Debugger(parmsDbg);
            Component.bindComponentControls(dbg, eDbg, PCJSCLASS);
        }
    };

    /*
     * Initialize every Debugger module on the page (as IF there's ever going to be more than one ;-))
     */
    web.onInit(Debugger.init);

}   // endif DEBUGGER

if (typeof module !== 'undefined') module.exports = Debugger;
