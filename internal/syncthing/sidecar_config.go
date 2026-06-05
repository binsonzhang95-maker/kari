package syncthing

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// ensureConfigXML guarantees <homeDir>/config.xml has:
//   - a `<gui>` block bound to 127.0.0.1:<guiPort>
//   - an `<options><listenAddress>` bound to tcp://127.0.0.1:<bepPort>
//
// The rest of the file is left untouched.
//
//   - Missing file → write the Kari-default minimal config (§4.5
//     step 4 options pinned off, no folders, no remote devices).
//   - Existing file → RMW the gui block only: read raw → splice in
//     Kari's freshly-rendered gui block → atomic .tmp + rename
//     write-back. Everything outside the gui block is preserved
//     byte-exactly, including any <folder> / <device> entries
//     syncthing has accreted across runs and any unknown elements
//     syncthing future-versions may add.
//
// API key is NEVER in config.xml — it lives only in STGUIAPIKEY env
// at spawn time (§3.7 D3). The gui-block RMW deliberately omits
// any <apikey> element; if syncthing wrote one previously, it gets
// dropped on the next rewrite. That's the intended behaviour —
// disk-resident API keys are exactly the persistence we're avoiding.
//
// HomeDir is created with 0700 if missing. If it exists with a
// different mode, that's the caller's problem to fix (callers
// enforce the §3.6 0700 invariant before invoking Start).
func ensureConfigXML(homeDir string, guiPort int, bepPort int) error {
	if homeDir == "" {
		return fmt.Errorf("syncthing config: empty homeDir")
	}
	if guiPort <= 0 || guiPort > 65535 {
		return fmt.Errorf("syncthing config: invalid gui port %d", guiPort)
	}
	if bepPort <= 0 || bepPort > 65535 {
		return fmt.Errorf("syncthing config: invalid bep port %d", bepPort)
	}
	if err := os.MkdirAll(homeDir, 0o700); err != nil {
		return fmt.Errorf("syncthing config: MkdirAll %s: %w", homeDir, err)
	}
	cfgPath := filepath.Join(homeDir, "config.xml")

	existing, err := os.ReadFile(cfgPath)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("syncthing config: read %s: %w", cfgPath, err)
	}

	var body []byte
	if errors.Is(err, fs.ErrNotExist) || len(existing) == 0 {
		// Missing OR empty file — write the Kari-default minimal
		// config. Empty file is treated equivalently to missing
		// because a 0-byte file is almost certainly the result of
		// a crashed/interrupted previous write, not deliberate
		// operator action.
		body = []byte(minimalConfigXML(guiPort, bepPort))
	} else {
		// Round-1 review High fix: existing config that can't be
		// RMW'd MUST fail-closed, not silently overwrite. The
		// pre-fix fallback to minimalConfigXML would wipe
		// syncthing-internal state (folders / devices / unknown
		// elements) that the operator may have spent significant
		// time accreting — exactly what the D7/D9 RMW
		// preservation principle exists to protect.
		//
		// Operator recovery path: read the error message →
		// inspect config.xml → repair manually (e.g. with `xmllint
		// --noout`) or, if the state is genuinely worthless,
		// `rm config.xml` to fall through to the missing-file
		// branch above.
		rewritten, rerr := rewriteGUIBlock(existing, guiPort)
		if rerr != nil {
			return fmt.Errorf("syncthing config: existing config.xml at %s cannot be RMW'd (%w); refusing to overwrite — manually inspect / repair or remove the file to fall through to the minimal-config bootstrap path", cfgPath, rerr)
		}
		rewritten, rerr = rewriteListenAddress(rewritten, bepPort)
		if rerr != nil {
			return fmt.Errorf("syncthing config: existing config.xml at %s cannot be RMW'd (%w); refusing to overwrite — manually inspect / repair or remove the file to fall through to the minimal-config bootstrap path", cfgPath, rerr)
		}
		body = rewritten
	}

	// Atomic write: .tmp + rename so a crash mid-write doesn't
	// leave a half-formed config that breaks the next launch.
	tmp := cfgPath + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return fmt.Errorf("syncthing config: write tmp: %w", err)
	}
	if err := os.Rename(tmp, cfgPath); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("syncthing config: rename %s → %s: %w", tmp, cfgPath, err)
	}
	return nil
}

// rewriteGUIBlock returns existing with the `<gui>...</gui>` block
// replaced by Kari's freshly-rendered block (per port + standard
// gui attrs). Everything else — including all whitespace, comments,
// declaration, doctype, and other elements — is preserved
// byte-exactly via a token-offset splice (no XML re-marshalling).
//
// Implementation uses xml.Decoder.InputOffset() to find the byte
// positions of the gui StartElement and its matching EndElement,
// then string-slices around them. If no <gui> element is found,
// returns existing with the new gui block injected just before
// </configuration>.
//
// Returns an error if the existing XML can't be parsed at all
// (unrecoverable corruption). Per the round-1 review High fix in
// ensureConfigXML, the caller REFUSES Start in that case rather
// than silently overwriting syncthing-accreted state. Operator
// inspection / repair / explicit `rm config.xml` is required to
// re-enable the minimal-config bootstrap path.
func rewriteGUIBlock(existing []byte, port int) ([]byte, error) {
	dec := xml.NewDecoder(bytes.NewReader(existing))

	var (
		guiStart  int64 = -1
		guiEnd    int64 = -1
		configEnd int64 = -1
		depth     int
		inGUI     bool
	)
	for {
		offBefore := dec.InputOffset()
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("syncthing config: parse existing: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if !inGUI && t.Name.Local == "gui" {
				guiStart = offBefore
				inGUI = true
				depth = 1
			} else if inGUI {
				depth++
			}
		case xml.EndElement:
			if inGUI {
				depth--
				if depth == 0 && t.Name.Local == "gui" {
					guiEnd = dec.InputOffset()
					inGUI = false
				}
			} else if t.Name.Local == "configuration" {
				configEnd = offBefore
			}
		}
	}

	newGUI := renderGUIBlock(port)

	if guiStart >= 0 && guiEnd > guiStart {
		var buf bytes.Buffer
		buf.Grow(len(existing) + len(newGUI))
		buf.Write(existing[:guiStart])
		buf.WriteString(newGUI)
		buf.Write(existing[guiEnd:])
		return buf.Bytes(), nil
	}

	// No gui block found — splice one in just before </configuration>.
	if configEnd > 0 {
		var buf bytes.Buffer
		buf.Grow(len(existing) + len(newGUI))
		buf.Write(existing[:configEnd])
		buf.WriteString(newGUI)
		buf.WriteString("\n")
		buf.Write(existing[configEnd:])
		return buf.Bytes(), nil
	}

	// Couldn't even find </configuration> — structurally broken;
	// surface to caller for fallback handling.
	return nil, errors.New("syncthing config: no <gui> block and no </configuration> closer found")
}

// renderGUIBlock returns the Kari-canonical <gui>...</gui> XML
// fragment. Indented 4 spaces to match minimalConfigXML's style.
// No <apikey> element (key flows via STGUIAPIKEY env).
func renderGUIBlock(port int) string {
	return fmt.Sprintf(`<gui enabled="true" tls="false">
        <address>127.0.0.1:%d</address>
    </gui>`, port)
}

// rewriteListenAddress returns existing with the first
// `<options><listenAddress>` block replaced by Kari's loopback-only
// BEP listen address. If the config has <options> but no
// listenAddress, it injects one just before </options>. If the config
// has no <options>, it injects a minimal options block just before
// </configuration>. Everything else is preserved byte-exactly.
func rewriteListenAddress(existing []byte, port int) ([]byte, error) {
	dec := xml.NewDecoder(bytes.NewReader(existing))

	var (
		listenStart int64 = -1
		listenEnd   int64 = -1
		optionsEnd  int64 = -1
		configEnd   int64 = -1

		inOptions   bool
		optionsDeep int
		inListen    bool
		listenDeep  int
	)
	for {
		offBefore := dec.InputOffset()
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("syncthing config: parse existing: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if inOptions {
				optionsDeep++
				if inListen {
					listenDeep++
				} else if t.Name.Local == "listenAddress" && listenStart < 0 {
					listenStart = offBefore
					inListen = true
					listenDeep = 1
				}
				continue
			}
			if t.Name.Local == "options" {
				inOptions = true
				optionsDeep = 1
			}
		case xml.EndElement:
			if inOptions {
				if inListen {
					listenDeep--
					if listenDeep == 0 && t.Name.Local == "listenAddress" {
						listenEnd = dec.InputOffset()
						inListen = false
					}
				}
				optionsDeep--
				if optionsDeep == 0 && t.Name.Local == "options" {
					optionsEnd = offBefore
					inOptions = false
				}
				continue
			}
			if t.Name.Local == "configuration" {
				configEnd = offBefore
			}
		}
	}

	newListen := renderListenAddress(port)
	if listenStart >= 0 && listenEnd > listenStart {
		var buf bytes.Buffer
		buf.Grow(len(existing) + len(newListen))
		buf.Write(existing[:listenStart])
		buf.WriteString(newListen)
		buf.Write(existing[listenEnd:])
		return buf.Bytes(), nil
	}
	if optionsEnd > 0 {
		var buf bytes.Buffer
		buf.Grow(len(existing) + len(newListen) + 5)
		buf.Write(existing[:optionsEnd])
		buf.WriteString(newListen)
		buf.WriteString("\n    ")
		buf.Write(existing[optionsEnd:])
		return buf.Bytes(), nil
	}
	if configEnd > 0 {
		newOptions := fmt.Sprintf(`    <options>
%s
    </options>
`, newListen)
		var buf bytes.Buffer
		buf.Grow(len(existing) + len(newOptions))
		buf.Write(existing[:configEnd])
		buf.WriteString(newOptions)
		buf.Write(existing[configEnd:])
		return buf.Bytes(), nil
	}
	return nil, errors.New("syncthing config: no <options> block and no </configuration> closer found")
}

func renderListenAddress(port int) string {
	return fmt.Sprintf(`        <listenAddress>tcp://127.0.0.1:%d</listenAddress>`, port)
}

// minimalConfigXML returns the Kari-default config.xml body for a
// freshly-initialized HomeDir. Schema follows Syncthing v1.27 config
// XML format. Notable choices:
//   - <gui enabled="true"> — REST API is hosted on the GUI port, so
//     this MUST be true (per §3.7 D3 GUI/REST clarification).
//   - <gui tls="false"> — loopback bind; TLS would just add cert
//     overhead with no security gain.
//   - <gui address="127.0.0.1:port"> — loopback-only listen.
//   - No <apikey> element — API key passed via STGUIAPIKEY env.
//   - All discovery / announce / relay / NAT options off
//     (§4.5 step 4 Kari-pinned).
//   - No <folder> or <device> elements — syncthing generates its
//     own device identity (cert.pem) on first start; folders are
//     added later via REST PUT from the reconciler.
func minimalConfigXML(guiPort int, bepPort int) string {
	return fmt.Sprintf(`<configuration version="37">
    <gui enabled="true" tls="false">
        <address>127.0.0.1:%d</address>
    </gui>
    <options>
        <listenAddress>tcp://127.0.0.1:%d</listenAddress>
        <localAnnounceEnabled>false</localAnnounceEnabled>
        <globalAnnounceEnabled>false</globalAnnounceEnabled>
        <relaysEnabled>false</relaysEnabled>
        <natEnabled>false</natEnabled>
        <urAccepted>-1</urAccepted>
        <crashReportingEnabled>false</crashReportingEnabled>
    </options>
</configuration>
`, guiPort, bepPort)
}
