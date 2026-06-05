import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count == 2 else {
  FileHandle.standardError.write(Data("Usage: swift scripts/generate-app-icons.swift <output-dir>\n".utf8))
  exit(64)
}

let outputDir = URL(fileURLWithPath: args[1], isDirectory: true)
let iconsetDir = outputDir.appendingPathComponent("icon.iconset", isDirectory: true)
let fm = FileManager.default
let outerInsetRatio: CGFloat = 0.075
let moonRotationDegrees: CGFloat = 18

try fm.createDirectory(at: outputDir, withIntermediateDirectories: true)
if fm.fileExists(atPath: iconsetDir.path) {
  try fm.removeItem(at: iconsetDir)
}
try fm.createDirectory(at: iconsetDir, withIntermediateDirectories: true)

func renderRoundedIcon(size: Int) -> NSImage {
  let rect = NSRect(x: 0, y: 0, width: size, height: size)
  let image = NSImage(size: rect.size)
  image.lockFocus()
  NSGraphicsContext.current?.imageInterpolation = .high
  NSColor.clear.setFill()
  rect.fill()
  let outerInset = CGFloat(size) * outerInsetRatio
  let iconRect = rect.insetBy(dx: outerInset, dy: outerInset)
  let radius = iconRect.width * 0.225
  let path = NSBezierPath(roundedRect: iconRect, xRadius: radius, yRadius: radius)
  NSColor.black.setFill()
  path.fill()
  path.addClip()

  let moonDiameter = iconRect.width * 0.72
  let moonCenter = NSPoint(x: iconRect.midX - iconRect.width * 0.075, y: iconRect.midY)
  drawCrescent(
    moonCenter: moonCenter,
    moonDiameter: moonDiameter,
    shadowOffset: NSPoint(x: iconRect.width * 0.205, y: iconRect.width * 0.04)
  )

  image.unlockFocus()
  return image
}

func renderSourceMark(size: Int) -> NSImage {
  let rect = NSRect(x: 0, y: 0, width: size, height: size)
  let image = NSImage(size: rect.size)
  image.lockFocus()
  NSGraphicsContext.current?.imageInterpolation = .high
  NSColor.clear.setFill()
  rect.fill()
  let moonDiameter = CGFloat(size) * 0.72
  let moonCenter = NSPoint(x: CGFloat(size) * 0.44, y: CGFloat(size) * 0.5)
  drawCrescent(
    moonCenter: moonCenter,
    moonDiameter: moonDiameter,
    shadowOffset: NSPoint(x: CGFloat(size) * 0.18, y: CGFloat(size) * 0.03)
  )
  image.unlockFocus()
  return image
}

func drawCrescent(moonCenter: NSPoint, moonDiameter: CGFloat, shadowOffset: NSPoint) {
  let moonRadius = moonDiameter / 2
  NSGraphicsContext.saveGraphicsState()
  let transform = NSAffineTransform()
  transform.translateX(by: moonCenter.x, yBy: moonCenter.y)
  transform.rotate(byDegrees: moonRotationDegrees)
  transform.translateX(by: -moonCenter.x, yBy: -moonCenter.y)
  transform.concat()

  let moonRect = NSRect(
    x: moonCenter.x - moonRadius,
    y: moonCenter.y - moonRadius,
    width: moonDiameter,
    height: moonDiameter
  )
  let moonPath = NSBezierPath(ovalIn: moonRect)
  let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 1.0, green: 0.973, blue: 0.875, alpha: 1.0),
    NSColor(calibratedRed: 0.945, green: 0.784, blue: 0.475, alpha: 1.0),
    NSColor(calibratedRed: 0.71, green: 0.545, blue: 0.275, alpha: 1.0)
  ])!
  gradient.draw(in: moonPath, angle: -48 + moonRotationDegrees)

  let shadowDiameter = moonDiameter * 0.96
  let shadowRadius = shadowDiameter / 2
  let shadowCenter = NSPoint(x: moonCenter.x + shadowOffset.x, y: moonCenter.y + shadowOffset.y)
  let shadowRect = NSRect(
    x: shadowCenter.x - shadowRadius,
    y: shadowCenter.y - shadowRadius,
    width: shadowDiameter,
    height: shadowDiameter
  )
  NSColor.black.setFill()
  NSBezierPath(ovalIn: shadowRect).fill()

  NSGraphicsContext.restoreGraphicsState()
}

func writePNG(_ image: NSImage, to url: URL) throws {
  guard
    let tiff = image.tiffRepresentation,
    let rep = NSBitmapImageRep(data: tiff),
    let data = rep.representation(using: .png, properties: [:])
  else {
    throw NSError(domain: "KariIconGeneration", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to encode PNG"])
  }
  try data.write(to: url)
}

let baseIcon = renderRoundedIcon(size: 1024)
try writePNG(baseIcon, to: outputDir.appendingPathComponent("icon.png"))
try writePNG(baseIcon, to: outputDir.appendingPathComponent("icon-mac-rounded.png"))
try writePNG(renderSourceMark(size: 1024), to: outputDir.appendingPathComponent("icon-source.png"))

let iconsetImages: [(String, Int)] = [
  ("icon_16x16.png", 16),
  ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32),
  ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128),
  ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256),
  ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512),
  ("icon_512x512@2x.png", 1024)
]

for (name, size) in iconsetImages {
  try writePNG(renderRoundedIcon(size: size), to: iconsetDir.appendingPathComponent(name))
}
