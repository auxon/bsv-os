import Foundation
import CoreImage
import CoreImage.CIFilterBuiltins
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// QR rendering. Phase 1 draws from the daemon's `addressQr` data URL when it
/// has one (the daemon already generates a PNG), and falls back to generating
/// from the raw address so the receive screen still works if that call fails.
public enum QRCode {
    /// Decode a `data:image/png;base64,…` URL into bytes, the way `Image` needs.
    public static func data(fromDataUrl url: String) -> Data? {
        guard let comma = url.firstIndex(of: ",") else { return nil }
        let meta = url[url.startIndex..<comma]
        guard meta.contains("base64") else { return nil }
        return Data(base64Encoded: String(url[url.index(after: comma)...]))
    }

    #if canImport(CoreImage)
    /// Generate a QR for a string. Used as the fallback above, and by anything
    /// that needs a code for data the daemon did not render (a payment request
    /// code, an identity key).
    public static func image(from text: String, scale: CGFloat = 10) -> Data? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) else {
            return nil
        }
        let context = CIContext()
        guard let cg = context.createCGImage(output, from: output.extent) else { return nil }
        #if canImport(UIKit)
        return UIImage(cgImage: cg).pngData()
        #elseif canImport(AppKit)
        let rep = NSBitmapImageRep(cgImage: cg)
        return rep.representation(using: .png, properties: [:])
        #else
        return nil
        #endif
    }
    #else
    public static func image(from text: String, scale: CGFloat = 10) -> Data? { nil }
    #endif
}
