import Foundation
import Capacitor

/**
 * `ShellSave` on iOS — the same five-call contract as the Android plugin
 * (`nativeSave.ts` is the page's half and is not forked for this).
 *
 * Why it exists here too: a `blob:` anchor download in WKWebView does nothing
 * Capacitor would see — no delegate takes it, no error, no file — so without
 * this plugin the app's one download button would be a dead button on iOS.
 *
 * Where the file lands: the app's Documents folder, which `UIFileSharingEnabled`
 * + `LSSupportsOpeningDocumentsInPlace` in Info.plist publish to the Files app
 * as *On My iPhone › waterplane*. That is iOS's nearest thing to Android's
 * Downloads — a folder the person can reach, open and share from without this
 * app — and, unlike a share sheet, it needs no tap the save did not ask for.
 * `where` says exactly that path, because it is the one the person has to look
 * for.
 *
 * Staging is a per-save file under tmp/, appended slice by slice (base64 of a
 * whole APK in one bridge call is ~31 MB of string), moved into Documents on
 * `finish`, removed on `abort`. A collision is renamed `name (2).ext`, the way
 * MediaStore does it, and the name actually used is what `where` returns.
 */
@objc(ShellSavePlugin)
public class ShellSavePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShellSavePlugin"
    public let jsName = "ShellSave"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "begin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "chunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "find", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abort", returnType: CAPPluginReturnPromise),
    ]

    /// What the Files app calls the Documents folder of this app.
    private static let shownAs = "On My iPhone/waterplane"

    private struct Pending {
        let part: URL
        let name: String
    }

    /// Saves in flight, by the token handed to JavaScript. Touched only on the
    /// plugin's serial queue, so no lock.
    private var pending: [String: Pending] = [:]
    private let queue = DispatchQueue(label: "dev.waterplane.app.save")

    private var fm: FileManager { FileManager.default }

    private var documents: URL {
        fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private var staging: URL {
        fm.temporaryDirectory.appendingPathComponent("saves", isDirectory: true)
    }

    /// A file name the person can see, never a path: no separators, no dot
    /// files, nothing empty. Null ⇒ refused.
    private static func cleanName(_ raw: String?) -> String? {
        guard let raw = raw else { return nil }
        let base = raw.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        let name = base.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || name.hasPrefix(".") { return nil }
        return name
    }

    @objc func begin(_ call: CAPPluginCall) {
        guard let name = Self.cleanName(call.getString("name")) else { call.reject("bad file name"); return }
        queue.async {
            do {
                try self.fm.createDirectory(at: self.staging, withIntermediateDirectories: true)
                let token = UUID().uuidString
                let part = self.staging.appendingPathComponent(token + ".part")
                guard self.fm.createFile(atPath: part.path, contents: nil) else {
                    call.reject("cannot open staging file"); return
                }
                self.pending[token] = Pending(part: part, name: name)
                call.resolve(["token": token])
            } catch {
                call.reject("cannot create staging folder", nil, error)
            }
        }
    }

    @objc func chunk(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), let b64 = call.getString("dataBase64") else {
            call.reject("bad arguments"); return
        }
        queue.async {
            guard let p = self.pending[token] else { call.reject("no such save"); return }
            guard let data = Data(base64Encoded: b64) else { call.reject("bad base64"); return }
            do {
                let h = try FileHandle(forWritingTo: p.part)
                defer { try? h.close() }
                try h.seekToEnd()
                try h.write(contentsOf: data)
                call.resolve()
            } catch {
                call.reject("write failed", nil, error)
            }
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let token = call.getString("token") else { call.reject("bad arguments"); return }
        queue.async {
            guard let p = self.pending.removeValue(forKey: token) else { call.reject("no such save"); return }
            do {
                try self.fm.createDirectory(at: self.documents, withIntermediateDirectories: true)
                let dest = self.freeName(p.name)
                try self.fm.moveItem(at: p.part, to: dest)
                call.resolve(["where": "\(Self.shownAs)/\(dest.lastPathComponent)"])
            } catch {
                try? self.fm.removeItem(at: p.part)
                call.reject("could not save to Files: \(error.localizedDescription)", nil, error)
            }
        }
    }

    @objc func abort(_ call: CAPPluginCall) {
        let token = call.getString("token") ?? ""
        queue.async {
            if let p = self.pending.removeValue(forKey: token) { try? self.fm.removeItem(at: p.part) }
            call.resolve()
        }
    }

    /**
     * Is a file of this name (or its `name (n).ext` collision copies) already
     * in Documents? With `size`, only a copy of exactly those bytes counts —
     * an APK or a build keeps its name across every build. The newest match
     * wins. `modified` is epoch milliseconds, as on Android.
     */
    @objc func find(_ call: CAPPluginCall) {
        guard let name = Self.cleanName(call.getString("name")) else { call.reject("bad file name"); return }
        let size = call.getInt("size")
        queue.async {
            let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
            let items = (try? self.fm.contentsOfDirectory(at: self.documents, includingPropertiesForKeys: keys)) ?? []
            var best: (url: URL, size: Int, modified: Date)?
            for u in items where Self.isCopy(u.lastPathComponent, of: name) {
                guard let v = try? u.resourceValues(forKeys: Set(keys)),
                      let s = v.fileSize, let m = v.contentModificationDate else { continue }
                if let want = size, want != s { continue }
                if best == nil || m > best!.modified { best = (u, s, m) }
            }
            guard let hit = best else { call.resolve(["present": false]); return }
            call.resolve([
                "present": true,
                "where": "\(Self.shownAs)/\(hit.url.lastPathComponent)",
                "size": hit.size,
                "modified": Int(hit.modified.timeIntervalSince1970 * 1000),
            ])
        }
    }

    // MARK: - Names

    private static func split(_ name: String) -> (stem: String, ext: String) {
        let ns = name as NSString
        let ext = ns.pathExtension
        return (ext.isEmpty ? name : ns.deletingPathExtension, ext.isEmpty ? "" : "." + ext)
    }

    /// `name`, or `stem (n).ext` — the names `freeName` can produce for it.
    private static func isCopy(_ have: String, of name: String) -> Bool {
        if have == name { return true }
        let (stem, ext) = split(name)
        guard have.hasPrefix(stem + " ("), have.hasSuffix(")" + ext) else { return false }
        let inner = have.dropFirst(stem.count + 2).dropLast(ext.count + 1)
        return !inner.isEmpty && inner.allSatisfy(\.isNumber)
    }

    private func freeName(_ name: String) -> URL {
        var url = documents.appendingPathComponent(name)
        let (stem, ext) = Self.split(name)
        var n = 2
        while fm.fileExists(atPath: url.path) {
            url = documents.appendingPathComponent("\(stem) (\(n))\(ext)")
            n += 1
        }
        return url
    }
}
