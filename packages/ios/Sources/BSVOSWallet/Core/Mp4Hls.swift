import Foundation

/// Split a fragmented MP4 into an HLS package.
///
/// WebKit cannot progressively demux the fMP4 that MediaRecorder writes — the
/// file has empty sample tables and relies wholly on `moof` fragments — so a
/// `<video src="recording.mp4">` loads metadata and then never advances, or
/// fails outright. HLS is the container WebKit does play without MSE, and the
/// live path already uses it. This packages a stored recording the same way:
/// the initialization segment (`ftyp`+`moov`) plus one fragment per
/// `moof`+`mdat`, with per-segment durations from the fragment timestamps.
public enum Mp4Hls {
    public struct Package: Sendable {
        public var initSegment: Data
        public var segments: [Data]
        public var durationsMs: [Int]
        public var playlist: String

        public var totalMs: Int { durationsMs.reduce(0, +) }
    }

    /// Nil when the input is not a fragmented MP4 (no moov, or no moof).
    public static func package(_ data: Data, defaultDurationSecs: Double = 1.0) -> Package? {
        let bytes = [UInt8](data)
        let top = boxes(bytes, in: 0..<bytes.count)
        guard let moov = top.first(where: { $0.type == "moov" }),
              let firstMoof = top.first(where: { $0.type == "moof" }) else {
            return nil
        }
        let initSegment = Data(bytes[0..<firstMoof.start])

        var segments: [Data] = []
        var starts: [Int] = [] // segment start in milliseconds, per track-independent max tfdt
        var cursor = firstMoof.start
        for box in top where box.start >= firstMoof.start {
            if box.type == "moof" {
                if cursor < box.start {
                    segments.append(Data(bytes[cursor..<box.start]))
                }
                cursor = box.start
                starts.append(fragmentStartMs(bytes, moof: box, moov: moov) ?? -1)
            }
        }
        guard cursor < bytes.count else { return nil }
        segments.append(Data(bytes[cursor..<bytes.count]))
        guard !segments.isEmpty else { return nil }

        let durations = segmentDurations(starts: starts)
        let seconds = durations.map { max(0.001, Double($0) / 1000) }
        let fallback = seconds.first(where: { $0 > 0.5 }) ?? defaultDurationSecs
        let target = max(1, Int(ceil(seconds.max() ?? fallback)))

        var playlist = [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            "#EXT-X-TARGETDURATION:\(target)",
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXT-X-MAP:URI=\"init.mp4\"",
        ]
        for (index, value) in seconds.enumerated() {
            let shown = value > 0.001 ? value : fallback
            playlist.append("#EXTINF:\(String(format: "%.3f", shown)),")
            playlist.append("seg-\(index).m4s")
        }
        playlist.append("#EXT-X-ENDLIST")

        return Package(
            initSegment: initSegment,
            segments: segments,
            durationsMs: durations,
            playlist: playlist.joined(separator: "\n") + "\n"
        )
    }

    /// Segment start times from `tfdt`, taken as the max across the fragment's
    /// tracks and converted through each track's `mdhd` timescale.
    private static func fragmentStartMs(_ bytes: [UInt8], moof: Box, moov: Box) -> Int? {
        let scales = trackTimescales(bytes, moov: moov)
        var best: Int?
        for traf in boxes(bytes, in: moof.payload..<moof.end) where traf.type == "traf" {
            let trackId = tfhdTrackId(bytes, traf: traf)
            let timescale = trackId.flatMap { scales[$0] } ?? 1000
            guard let tfdt = boxes(bytes, in: traf.payload..<traf.end).first(where: { $0.type == "tfdt" }) else {
                continue
            }
            let version = bytes[tfdt.start + 8]
            let value = version == 1 ? readU64(bytes, tfdt.start + 12) : UInt64(readU32(bytes, tfdt.start + 12))
            let ms = Int(value * 1000 / UInt64(max(1, timescale)))
            if best == nil || ms > best! { best = ms }
        }
        return best
    }

    private static func segmentDurations(starts: [Int]) -> [Int] {
        guard !starts.isEmpty else { return [] }
        var durations: [Int] = []
        for index in 0..<starts.count {
            if index + 1 < starts.count, starts[index] >= 0, starts[index + 1] >= starts[index] {
                durations.append(starts[index + 1] - starts[index])
            } else if let last = durations.last {
                durations.append(last)
            } else {
                durations.append(0)
            }
        }
        // A single fragment has no delta to learn from; leave it to the caller's
        // fallback rather than inventing a length.
        if durations.allSatisfy({ $0 == 0 }) { return durations.map { _ in 0 } }
        return durations
    }

    /// Track id → `mdhd` timescale, from the movie header's track boxes.
    private static func trackTimescales(_ bytes: [UInt8], moov: Box) -> [UInt32: Int] {
        var scales: [UInt32: Int] = [:]
        for trak in boxes(bytes, in: moov.payload..<moov.end) where trak.type == "trak" {
            guard let tkhd = boxes(bytes, in: trak.payload..<trak.end).first(where: { $0.type == "tkhd" }) else {
                continue
            }
            let trackVersion = bytes[tkhd.start + 8]
            let trackId = trackVersion == 1 ? readU32(bytes, tkhd.start + 28) : readU32(bytes, tkhd.start + 20)
            guard let mdia = boxes(bytes, in: trak.payload..<trak.end).first(where: { $0.type == "mdia" }),
                  let mdhd = boxes(bytes, in: mdia.payload..<mdia.end).first(where: { $0.type == "mdhd" }) else {
                continue
            }
            let version = bytes[mdhd.start + 8]
            let timescale = version == 1 ? readU32(bytes, mdhd.start + 28) : readU32(bytes, mdhd.start + 20)
            scales[trackId] = Int(timescale)
        }
        return scales
    }

    private static func tfhdTrackId(_ bytes: [UInt8], traf: Box) -> UInt32? {
        guard let tfhd = boxes(bytes, in: traf.payload..<traf.end).first(where: { $0.type == "tfhd" }) else {
            return nil
        }
        return readU32(bytes, tfhd.start + 12)
    }

    // MARK: - box walking

    struct Box {
        var start: Int
        var end: Int
        var payload: Int
        var type: String
    }

    static func boxes(_ bytes: [UInt8], in range: Range<Int>) -> [Box] {
        var out: [Box] = []
        var offset = range.lowerBound
        while offset + 8 <= range.upperBound {
            let size32 = readU32(bytes, offset)
            let type = String(bytes: bytes[(offset + 4)..<(offset + 8)], encoding: .ascii) ?? ""
            var size = Int(size32)
            var header = 8
            if size == 1 {
                guard offset + 16 <= range.upperBound else { break }
                size = Int(readU64(bytes, offset + 8))
                header = 16
            } else if size == 0 {
                size = range.upperBound - offset
            }
            guard size >= header, offset + size <= range.upperBound else { break }
            out.append(Box(start: offset, end: offset + size, payload: offset + header, type: type))
            offset += size
        }
        return out
    }

    static func readU32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        guard offset >= 0, offset + 4 <= bytes.count else { return 0 }
        return UInt32(bytes[offset]) << 24 | UInt32(bytes[offset + 1]) << 16
            | UInt32(bytes[offset + 2]) << 8 | UInt32(bytes[offset + 3])
    }

    static func readU64(_ bytes: [UInt8], _ offset: Int) -> UInt64 {
        guard offset >= 0, offset + 8 <= bytes.count else { return 0 }
        var value: UInt64 = 0
        for index in 0..<8 { value = value << 8 | UInt64(bytes[offset + index]) }
        return value
    }
}
