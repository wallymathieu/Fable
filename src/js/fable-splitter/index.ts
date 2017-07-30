import * as Babel from "babel-core";
import * as fs from "fs";
import * as Path from "path";
import * as Process from "process";
const client = require("fable-utils/client");
const babelPlugins = require("fable-utils/babel-plugins");

const customPlugins = [
    babelPlugins.getRemoveUnneededNulls(),
    babelPlugins.getTransformMacroExpressions(Babel.template),
];

const DEFAULT_PORT = parseInt(Process.env.FABLE_SERVER_PORT || "61225", 10);
const FSHARP_EXT = /\.(fs|fsx|fsproj)$/;
const FSPROJ_EXT = /\.fsproj$/;
const JAVASCRIPT_EXT = /\.js$/;

type CompilationInfo = {
    compiledPaths: Set<string>, // already compiled paths
    dedupOutPaths: Set<string>, // lookup of output paths
    mapInOutPaths: Map<string, string>, // map of input to output paths
    logs: { [severity: string]: string[] },
}

export type FableOptions = {
    path?: string;
    define?: string[];
    plugins?: string[];
    fableCore?: string;
    typedArrays?: boolean;
    clampByteArrays?: boolean;
    // extra?: any;
};

export type FableCompilerOptions = {
    entry: string;
    outDir: string;
    port?: number;
    babel?: Babel.TransformOptions;
    fable?: FableOptions;
    prepack?: any;
};

function output(msg: string, severity: string) {
    if (severity === "warning") {
        console.warn(msg);
    }
    else if (severity === "error") {
        console.error(msg);
    }
    else {
        console.log(msg);
    }
}


function addLogs(logs: { [key:string]: string[] }, info: CompilationInfo) {
    if (typeof logs === "object") {
        Object.keys(logs).forEach(key => {
            info.logs[key] = key in info.logs
                ? info.logs[key].concat(logs[key])
                : ensureArray(logs[key]);
        });
    }
}

function ensureArray(obj: any) {
    return (Array.isArray(obj) ? obj : obj != null ? [obj] : []);
}

export function ensureDirExists(dir: string, cont?: ()=>void) {
    if (fs.existsSync(dir)) {
        if (typeof cont === "function") { cont(); }
    }
    else {
        ensureDirExists(Path.dirname(dir), function() {
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir); }
            if (typeof cont === "function") { cont(); }
        })
    }
}

// TODO: implement better folder structure
function getOutPath(fullPath: string, info: CompilationInfo) {
    const srcPath = fullPath.replace(/\\/g, "/");
    let outPath = info.mapInOutPaths.get(srcPath);
    if (!outPath) {
        // get file name without extensions
        const fileName = Path.basename(srcPath)
            .replace(FSHARP_EXT, "").replace(JAVASCRIPT_EXT, "");
        // flat folder structure (one level deep)
        const fileDir = Path.basename(Path.dirname(srcPath));
        const newPath = Path.join(fileDir, fileName).replace(/\\/g, "/");
        // dedup output path
        let i = 0;
        outPath = newPath;
        while (info.dedupOutPaths.has(outPath)) {
            outPath = `${newPath}${++i}`;
        }
        info.dedupOutPaths.add(outPath);
        info.mapInOutPaths.set(srcPath, outPath);
    }
    return outPath;
}

function getFullPath(relPath: string) {
    const fullPath = Path.resolve(relPath).replace(/\\/g, "/");
    if (FSHARP_EXT.test(fullPath) || JAVASCRIPT_EXT.test(fullPath)) {
        return fullPath;
    } else {
        return fullPath + ".js";
    }
}

function fixPath(dir: string, path: string, info: CompilationInfo) {
    if (!path.startsWith(".")) { return path; } // no need to fix, i.e. node package
    const relPath = Path.join(dir, path);
    const fullPath = getFullPath(relPath);
    const newPath = Path.join("..", getOutPath(fullPath, info)); // assumes flat folder structure
    return newPath.replace(/\\/g, "/");
}

function getImportPaths(ast: any): string[] {
    const decls = ast && ast.program ? ensureArray(ast.program.body) : [];
    return decls
        .filter((d) => d.source != null)
        .map((d) => d.source.value);
}

function fixImportPaths(dir: string, ast: any, info: CompilationInfo) {
    const decls = ast && ast.program ? ensureArray(ast.program.body) : [];
    decls
        .filter((d) => d.source != null)
        .forEach((d) => { d.source.value = fixPath(dir, d.source.value, info); });
}

async function getFileAstAsync(path: string, options: FableCompilerOptions, info: CompilationInfo) {
    let ast: Babel.BabelFileResult | undefined;
    if (FSHARP_EXT.test(path)) {
        // return Babel AST from F# file
        const fableMsg = JSON.stringify(Object.assign({}, options.fable, { path }));
        const response = await client.send(options.port, fableMsg);
        const babelAst = JSON.parse(response);
        if (babelAst.error) {
            throw new Error(babelAst.error);
        }
        addLogs(babelAst.logs, info);
        ast = Babel.transformFromAst(babelAst, undefined, { code: false });
    } else {
        // return Babel AST from JS file
        path = JAVASCRIPT_EXT.test(path) ? path : path + ".js";
        if (fs.existsSync(path)) {
            try {
                ast = Babel.transformFileSync(path, { code: false });
            }
            catch (err) {
                const log = `${path}(1,1): error BABEL: ${err.message}`;
                addLogs({ error: [log] }, info);
            }
        }
        else {
            console.log(`fable: Skipping missing JS file: ${path}`);
        }
    }
    return ast;
}

function transformAndSaveAst(fullPath: string, ast: any, options: FableCompilerOptions, info: CompilationInfo) {
    // resolve output paths
    const outPath = getOutPath(fullPath, info) + ".js";
    const jsPath = Path.join(options.outDir, outPath);
    const jsDir = Path.dirname(jsPath);
    ensureDirExists(jsDir);
    // set sourcemap paths
    const code: string | undefined = undefined;
    if (options.babel && options.babel.sourceMaps) {
        // code = fs.readFileSync(fullPath, "utf8");
        const relPath = Path.relative(jsDir, fullPath);
        options.babel.sourceFileName = relPath.replace(/\\/g, "/");
        options.babel.sourceMapTarget = Path.basename(outPath);
    }
    // transform and save
    let result = Babel.transformFromAst(ast, code, options.babel);
    if (options.prepack) {
        const prepack = require("prepack");
        result = prepack.prepackFromAst(result.ast, result.code, options.prepack);
    }
    if (result && result.code) { fs.writeFileSync(jsPath, result.code); }
    if (result && result.map) { fs.writeFileSync(jsPath + ".map", JSON.stringify(result.map)); }
    console.log(`fable: Compiled ${Path.relative(process.cwd(), fullPath)}`);
}

async function transformAsync(path: string, options: FableCompilerOptions, info: CompilationInfo) {
    // if already compiled, do nothing
    const fullPath = getFullPath(path);
    if (info.compiledPaths.has(fullPath)) {
        return;
    }
    info.compiledPaths.add(fullPath);

    // get file AST (no transformation)
    const ast = await getFileAstAsync(fullPath, options, info);
    if (ast) {
        // get/fix import paths
        const importPaths = getImportPaths(ast.ast);
        fixImportPaths(Path.dirname(fullPath), ast.ast, info);

        // if not a .fsproj, transform and save
        if (!FSPROJ_EXT.test(fullPath)) {
            transformAndSaveAst(fullPath, ast.ast, options, info);
        }

        // compile all dependencies (imports)
        const dir = Path.dirname(fullPath);
        for (const importPath of importPaths) {
            const relPath = Path.join(dir, importPath);
            await transformAsync(relPath, options, info);
        }
    }
}

export default function fableSplitter(options: FableCompilerOptions) {
    // set defaults
    options = options || {};
    options.outDir = options.outDir || ".";
    options.port = options.port || DEFAULT_PORT;

    options.fable = options.fable || {};
    options.babel = options.babel || {};
    options.babel.plugins = customPlugins.concat(options.babel.plugins || []);
    // options.prepack = options.prepack;

    const res = {
        compiledPaths: new Set<string>(),
        dedupOutPaths: new Set<string>(),
        mapInOutPaths: new Map<string, string>(),
        logs: {} as { [key: string]: string[] },
    }

    // main loop
    console.log("fable: Compiling...");
    return transformAsync(options.entry, options, res)
        .then(() => {
            Object.keys(res.logs).forEach(severity =>
                ensureArray(res.logs[severity]).forEach(log =>
                    output(log, severity))
            );
            const hasError = Array.isArray(res.logs.error) && res.logs.error.length > 0;
            console.log(`fable: Compilation ${hasError ? "failed" : "succeeded"}`);
            return hasError ? 0 : 1;
        })
        .catch((err) => {
            console.error(`ERROR: ${err.message}`);
            if (err.message.indexOf("ECONN") !== -1) {
                console.log(`Make sure Fable server is running on port ${options.port}`);
            }
            return 1;
        });
}
