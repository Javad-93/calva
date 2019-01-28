import * as vscode from 'vscode';
import * as _ from 'lodash';
import * as fs from 'fs';
import * as state from './state';
import * as util from './utilities';
import * as shadow from "./shadow"
import status from './status';
import terminal from './terminal';

import { NReplClient, NReplSession } from "./nrepl";

function nreplPortFile() {
    if (fs.existsSync(shadow.shadowNReplPortFile()))
        return shadow.shadowNReplPortFile();
    else
        return util.getProjectDir() + '/.nrepl-port'
}

function disconnect(options = null, callback = () => { }) {
    ['clj', 'cljs'].forEach(sessionType => {
        state.cursor.set(sessionType, null);
    });
    state.cursor.set("connected", false);
    state.cursor.set('cljc', null);
    status.update();

    nClient.close();
    callback();
}

async function connectToHost(hostname, port) {
    let chan = state.deref().get('outputChannel');
    if(nClient) {
        nClient["silent"] = true;
        nClient.close();
    }
    state.cursor.set('connecting', true);
    status.update();
    try {
        chan.appendLine("Hooking up nREPL sessions...");
        // Create an nREPL client. waiting for the connection to be established.
        nClient = await NReplClient.create({ host: hostname, port: +port})
        nClient.onClose(c => {
            state.cursor.set("connected", false);
            state.cursor.set("connecting", false);
            if(!c["silent"]) // we didn't deliberately close this session, mention this fact.
                chan.appendLine("nREPL Connection was closed");
            status.update();
        })
        cljSession = nClient.session;
        chan.appendLine("Connected session: clj");
        
        state.cursor.set("connected", true);
        state.cursor.set("connecting", false);
        state.cursor.set('clj', cljSession)
        state.cursor.set('cljc', cljSession)
        status.update();

        //cljsSession = nClient.session;
        //terminal.createREPLTerminal('clj', null, chan);

        let [cljsSession, shadowBuild] = await makeCljsSessionClone(cljSession, null);
        if (cljsSession)
            setUpCljsRepl(cljsSession, chan, shadowBuild);
        chan.appendLine('cljc files will use the clj REPL.' + (cljsSession ? ' (You can toggle this at will.)' : ''));
        //evaluate.evaluateFile();
        status.update();

    } catch(e) {
        state.cursor.set("connected", false);
        state.cursor.set("connecting", false);
        chan.appendLine("Failed connecting. (Calva needs a REPL started before it can connect.)");
        return false;
    }

    return true;

    /*
    disconnect({ hostname, port }, () => {
        let onDisconnect = (_client, err) => {
            chan.appendLine("Disconnected from nREPL server." + (err ? " Error: " + err : ""));
            state.cursor.set("clj", null);
            state.cursor.set("cljc", null);
            state.cursor.set("connected", false);
            state.cursor.set("connecting", false);
            status.update();
        }
    });
    */
}

function setUpCljsRepl(cljsSession, chan, shadowBuild) {
    state.cursor.set("cljs", cljsSession);
    chan.appendLine("Connected session: cljs");
    //terminal.createREPLTerminal('cljs', shadowBuild, chan);
    status.update();
}

interface ReplType {
    name: string,
    ns: string;
    connect: () => Promise<string>;
}

let cljsReplTypes: ReplType[] = [
    {
        name: "Figwheel Main",
        ns: "figwheel.main",
        connect: async () => {
            let res = fs.readdirSync(util.getProjectDir());
            let projects = res.filter(x => x.match(/.cljs.edn/));
            let result = await util.quickPickSingle({ values: projects, placeHolder: "Please select a figwheel-main project", saveAs: "figwheel-main-project"})
            if(result)
              return `(do (require 'figwheel.main) (figwheel.main/start :${result.match(/^(.*)\.cljs\.edn$/)[1]}))`
            else throw "Aborted";
        }
    },
    {
        name: "Figwheel",
        ns: "figwheel-sidecar.repl-api",
        connect: async () => {
            return "(do (require 'figwheel-sidecar.repl-api) (if (not (figwheel-sidecar.repl-api/figwheel-running?)) (figwheel-sidecar.repl-api/start-figwheel!)) (figwheel-sidecar.repl-api/cljs-repl))"
        }
    }
]

async function probeNamespaces(namespaces: string[]) {
    let result: string = await cljSession.eval(`(remove nil? (map #(try (do (require %) %) (catch Exception e)) '[${namespaces.join(' ')}]))`).value;
    return result.substring(1, result.length-1).split(' ')
}

async function findCljsRepls(): Promise<ReplType[]> {
    let probe = [];
    for(let repl of cljsReplTypes)
        probe.push(repl.ns);
    let valid = await probeNamespaces(probe);
    let output: ReplType[] = [];
    for(let repl of cljsReplTypes) {
        if(valid.indexOf(repl.ns) != -1)
            output.push(repl);
    }
    return output;
}
let connectionChannel = vscode.window.createOutputChannel("Calva CLJS Connection");

async function makeCljsSessionClone(session, shadowBuild) {
    let chan = state.deref().get('outputChannel');
    if (shadow.isShadowCljs() && !shadowBuild) {
        chan.appendLine("This looks like a shadow-cljs coding session.");
        let build = await util.quickPickSingle({ values: shadow.shadowBuilds(), placeHolder: "Select which shadow-cljs CLJS REPL to connect to", saveAs: "shadow-cljs-project"})
        if (build) {
            state.extensionContext.workspaceState.update("cljs-build", build)
            return makeCljsSessionClone(session, build);
        }
    } else {
        cljsSession = await cljSession.clone();
        if(cljsSession) {
            connectionChannel.clear();
            connectionChannel.show();
            let initCode = shadowBuild ? shadowCljsReplStart(shadowBuild) : util.getCljsReplStartCode();
            if(!shadowBuild) {
                let repls = await findCljsRepls();
                let replType = await util.quickPickSingle({ values: repls.map(x => x.name), placeHolder: "Select a cljs repl to use", saveAs: "cljs-repl-type" });
                if(!replType)
                    return;
                let repl = repls.find(x => x.name == replType);
                connectionChannel.appendLine("Connecting to "+repl.name);
                initCode = await repl.connect();
            } else {
                connectionChannel.appendLine("Connecting to ShadowCLJS")
            }
            try {
                let result = cljsSession.eval(initCode, { stdout: x => connectionChannel.append(util.stripAnsi(x)), stderr: x => connectionChannel.append(util.stripAnsi(x)) });
                let valueResult = await result.value
                
                state.cursor.set('cljs', cljsSession)
                if(!shadowBuild && result.ns){
                    state.cursor.set('shadowBuild', null)
                    return [cljsSession, null];
                } else if(shadowBuild  && valueResult.match(/:selected/)) {
                    state.cursor.set('shadowBuild', shadowBuild);
                    return [cljsSession, shadowBuild];
                }
            } catch(e) {
                if(shadowBuild) {
                    let failed = `Failed starting cljs repl for shadow-cljs build: ${shadowBuild}`;
                    state.cursor.set('shadowBuild', null);
                    chan.appendLine(`${failed}. Is the build running and conected?`);
                    console.error(failed);
                } else {
                    let failed = `Failed to start ClojureScript REPL with command: ${initCode}`;
                    console.error(failed);
                    chan.appendLine(`${failed}. Is the app running in the browser and conected?`);
                }
            }
        }
    }
    return [null, null];
}

function shadowCljsReplStart(buildOrRepl: string) {
    if(!buildOrRepl)
        return null;
    if(buildOrRepl.charAt(0) == ":")
        return `(shadow.cljs.devtools.api/nrepl-select ${buildOrRepl})`
    else
        return `(shadow.cljs.devtools.api/${buildOrRepl})`
}

async function promptForNreplUrlAndConnect(port) {
    let current = state.deref(),
        chan = current.get('outputChannel');

    let url = await vscode.window.showInputBox({
        placeHolder: "Enter existing nREPL hostname:port here...",
        prompt: "Add port to nREPL if localhost, otherwise 'hostname:port'",
        value: "localhost:" + (port ? port : ""),
        ignoreFocusOut: true
    })
    // state.reset(); TODO see if this should be done
    if (url !== undefined) {
        let [hostname, port] = url.split(':'),
            parsedPort = parseFloat(port);
        if (parsedPort && parsedPort > 0 && parsedPort < 65536) {
            state.cursor.set("hostname", hostname);
            state.cursor.set("port", parsedPort);
            connectToHost(hostname, parsedPort);
        } else {
            chan.appendLine("Bad url: " + url);
            state.cursor.set('connecting', false);
            status.update();
        }
    } else {
        state.cursor.set('connecting', false);
        status.update();
    }
    return true;
}

export let nClient: NReplClient;
export let cljSession: NReplSession;
export let cljsSession: NReplSession;

async function connect(isAutoConnect = false) {
    let current = state.deref(),
        chan = current.get('outputChannel');


    if (fs.existsSync(nreplPortFile())) {
        let port = fs.readFileSync(nreplPortFile(), 'utf8');
        if (port) {
            if (isAutoConnect) {
                state.cursor.set("hostname", "localhost");
                state.cursor.set("port", port);
                await connectToHost("localhost", port);
            } else {
                await promptForNreplUrlAndConnect(port);
            }
        } else {
            chan.appendLine('No nrepl port file found. (Calva does not start the nrepl for you, yet.) You might need to adjust "calva.projectRootDirectory" in Workspace Settings.');
            await promptForNreplUrlAndConnect(port);
        }
    } else {
        await promptForNreplUrlAndConnect(null);
    }
    return true;
}

function reconnect() {
    state.reset();
    connect(true);
}

function autoConnect() {
    connect(true);
}

function toggleCLJCSession() {
    let current = state.deref();

    if (current.get('connected')) {
        if (util.getSession('cljc') == util.getSession('cljs')) {
            state.cursor.set('cljc', util.getSession('clj'));
        } else if (util.getSession('cljc') == util.getSession('clj')) {
            state.cursor.set('cljc', util.getSession('cljs'));
        }
        status.update();
    }
}

async function recreateCljsRepl() {
    let current = state.deref(),
        cljSession = util.getSession('clj'),
        chan = current.get('outputChannel');

    let [session, shadowBuild] = await makeCljsSessionClone(cljSession, null);
    if (session)
        setUpCljsRepl(session, chan, shadowBuild);
    status.update();
}

export default {
    connect,
    disconnect,
    reconnect,
    autoConnect,
    nreplPortFile,
    toggleCLJCSession,
    recreateCljsRepl
};
