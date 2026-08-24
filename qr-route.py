import re
p = "core/server.ts"
s = open(p).read()

# insert QR route before the paymentStatus route
qr_route = '''    // QR code (SVG) for a payment invoice - used by the wallet UI receive flow.
    const paymentQr = u.pathname.match(/^\\/api\\/payments\\/([^/]+)\\/qr$/);
    if (req.method === "GET" && paymentQr) {
      const paymentHash = decodeURIComponent(paymentQr[1]);
      const [invoice] = await db.select({ bolt11: pendingInvoicesTable.bolt11 }).from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash, paymentHash));
      if (!invoice?.bolt11) return json(res, 404, { error: "Invoice not found" });
      const QRCode = (await import("qrcode")).default;
      const svg = await QRCode.toString(`lightning:${invoice.bolt11}`, { type: "svg", margin: 1, width: 320, color: { dark: "#f4f6f5", light: "#0a0f0f" } });
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      return res.end(svg);
    }
'''
anchor = '    const paymentStatus = u.pathname.match(/^\\/api\\/payments\\/([^/]+)\\/status$/);'
assert anchor in s, "anchor not found"
s = s.replace(anchor, qr_route + anchor)
open(p, "w").write(s)
print("QR route inserted")
