# Inkseal

**Seal your artwork with your own handwriting, an unforgeable digital signature and an invisible creator ID.**
Free, open source, and everything runs on your own device.

**▶ Use it now: https://ronsuthlor3-lab.github.io/inkseal/**

[ภาษาไทย](README.th.md)

---

## What it does

When you seal an image, Inkseal adds four layers of protection:

| Layer | What it is | What it gives you |
|---|---|---|
| ✍️ **Handwritten signature** | You sign with a mouse, pen or finger. Stroke width follows pen pressure or writing speed, and the signature is drawn on the work. | A visible mark. It stops casual copying. |
| 🔐 **Digital signature** (Ed25519) | Your name, the title, the license and a SHA-256 hash of the image are signed with your private key and stored inside the file. | **Cannot be forged.** If a single pixel changes, verification shows "modified". |
| 👻 **Invisible creator ID** | A short ID derived from your key is hidden in the pixels with a DCT watermark. | It is still there after the metadata is stripped or the file is re-saved as JPEG. |
| ⏱️ **Public timestamp** (optional) | The file hash is anchored in Bitcoin via [OpenTimestamps](https://opentimestamps.org). | Proof that you had this exact file at that time, before anyone else. |

Anyone can open the **Verify** tab and see who sealed an image, whether it changed afterwards, and
whether the hidden creator ID matches the sealer. If a thief strips your seal and seals the stolen copy
as their own, the verifier shows a mismatch warning.

## Honest limits (please read)

No technology makes theft impossible. Anything people can see, they can screenshot. Inkseal does not
lock files. What it does is make ownership **provable** and tampering **detectable**.

- The digital signature can be **removed**, but it cannot be faked. A file without a seal proves nothing either way.
- The invisible watermark survives re-saving and JPEG compression down to about quality 60–75.
  It does **not** survive cropping, resizing, rotation or heavy filters.
- Very bright or very dark flat areas (e.g. a pure white background) cannot hold the watermark.
  Those areas are skipped automatically.
- The "sealed at" time is whatever the creator's clock said. Only the `.ots` file proves time.
- If someone steals your identity file **and** your passphrase, they can sign as you. Keep both safe.

## Use it

### In the browser (no install)

Open the hosted page (GitHub Pages), or serve this folder with any static web server:

```bash
npx serve .
```

1. **Identity**: create your identity. A file `inkseal-identity-<name>.json` downloads. **Back it up.**
2. **Signature**: sign in the box and save.
3. **Seal**: drop an image, place your signature, fill in the title and license, then press *Seal & download*.
4. **Verify**: drop any image to check it.

Requires a browser with Ed25519 WebCrypto support: Chrome/Edge 137+, Firefox 129+ or Safari 17+.

### Command line (batch sealing)

Requires Node.js 20 or newer.

```bash
npm install
```

```bash
node cli/inkseal.js keygen --name "Your Name" --contact "instagram.com/you"
```

```bash
node cli/inkseal.js seal ./artworks --id me.inkseal-id.json --signature my-signature.png --position br --timestamp
```

```bash
node cli/inkseal.js verify ./artworks/sunset.sealed.png
```

Run `node cli/inkseal.js --help` for all options. The passphrase is asked interactively, or read from
the `INKSEAL_PASSPHRASE` environment variable for scripts.

## How it works

```
your image ─► draw handwritten signature ─► embed invisible creator ID ─► encode PNG/JPEG
                                                                              │
             manifest { creator, work, license, sealedAt, sha256(file), public key }
                                                                              │
                                     sign with Ed25519 private key ◄──────────┘
                                                                              │
             store { manifest, signature } inside the file ─► optional .ots timestamp
```

- **Where the seal lives:** a PNG `iTXt` chunk with the keyword `inkseal`, or a JPEG `APP15`
  segment starting with `INKSEAL\0`. The signed hash covers the whole file *except* this record.
- **Identity file:** the Ed25519 private key is encrypted with AES-256-GCM, using a key derived from
  your passphrase with PBKDF2-SHA256 (310,000 iterations).
- **Creator ID:** the first 6 bytes of SHA-256(public key), shown as `XXXX-XXXX-XXXX`.
- **Watermark:** a 48-bit creator ID plus CRC-16 is embedded by quantization index modulation on two
  mid-frequency DCT coefficients of each 8×8 luminance block. It is repeated across the image and
  decoded by soft majority vote.

Code layout:

```
core/        shared by web and CLI (no dependencies)
  container.js   read/write the seal inside PNG and JPEG
  identity.js    key creation and passphrase encryption
  seal.js        sign and verify
  watermark.js   invisible creator ID
  timestamp.js   OpenTimestamps proof
  raster.js      drawing the signature without a canvas (CLI)
web/         browser UI (index.html at repo root)
cli/         command line tool
test/        node --test
```

## Publish on GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to **Settings → Pages** and set **Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
3. The app will be live at `https://<you>.github.io/<repo>/`.

## Contributing

Ideas that would make Inkseal better:

- A watermark that survives cropping and resizing (synchronisation templates)
- Export to the [C2PA / Content Credentials](https://c2pa.org) standard
- PDF and video support
- A public directory where artists can register their Creator ID

## License

MIT. Free for everyone, forever.
