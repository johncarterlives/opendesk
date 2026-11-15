// Package samlsp holds what a brand's SAML 2.0 sign-in configuration is made of and how it is
// checked, shared by the settings that save it and the portal that signs customers in with it
// (contracts/customer-portal.md "SAML").
package samlsp

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"net/url"
	"strings"
	"time"
)

// MaxCertificates bounds the signing certificates one provider has, so a key can be rolled
// over with both certificates trusted for a while.
const MaxCertificates = 3

// ParseCertificates reads PEM certificates, or one bare base64 DER certificate as an
// identity provider's metadata carries it. Certificates must carry an RSA key of at least 2048
// bits, and (unless now is zero, as when signing in, where the signature check judges the
// dates) be valid at now; anything else is refused, naming nothing of the input.
func ParseCertificates(text string, now time.Time) ([]*x509.Certificate, error) {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > 32<<10 {
		return nil, errors.New("no certificate")
	}
	var ders [][]byte
	if strings.Contains(text, "-----BEGIN") {
		rest := []byte(text)
		for {
			var blk *pem.Block
			blk, rest = pem.Decode(rest)
			if blk == nil {
				break
			}
			if blk.Type != "CERTIFICATE" {
				return nil, errors.New("not a certificate")
			}
			ders = append(ders, blk.Bytes)
		}
		if len(strings.TrimSpace(string(rest))) > 0 {
			return nil, errors.New("trailing data")
		}
	} else {
		der, err := decodeBase64(text)
		if err != nil {
			return nil, err
		}
		ders = [][]byte{der}
	}
	if len(ders) == 0 || len(ders) > MaxCertificates {
		return nil, errors.New("one to three certificates")
	}
	out := make([]*x509.Certificate, 0, len(ders))
	for _, der := range ders {
		c, err := x509.ParseCertificate(der)
		if err != nil {
			return nil, errors.New("unreadable certificate")
		}
		if !now.IsZero() && (now.Before(c.NotBefore) || now.After(c.NotAfter)) {
			return nil, errors.New("certificate is not valid now")
		}
		key, ok := c.PublicKey.(*rsa.PublicKey)
		if !ok || key.N.BitLen() < 2048 {
			return nil, errors.New("an RSA key of at least 2048 bits is needed")
		}
		out = append(out, c)
	}
	return out, nil
}

func decodeBase64(s string) ([]byte, error) {
	var b strings.Builder
	for _, r := range s {
		if r != ' ' && r != '\n' && r != '\r' && r != '\t' {
			b.WriteRune(r)
		}
	}
	return base64.StdEncoding.DecodeString(b.String())
}

// Normalize returns the certificates as PEM, the form they are stored in.
func Normalize(certs []*x509.Certificate) string {
	var b strings.Builder
	for _, c := range certs {
		b.Write(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Raw}))
	}
	return b.String()
}

// ValidEntityID reports an identity provider's entity id: a URL or URN, at most 1000 bytes,
// free of control characters.
func ValidEntityID(s string) bool {
	if s == "" || len(s) > 1000 || strings.TrimSpace(s) != s {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// ValidSSOURL reports an https sign-in URL without credentials or a fragment.
func ValidSSOURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && len(s) <= 2000 && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Fragment == ""
}
