package main

// Núcleo OpenPGP do Assinador Dağ Döş: gerar chave, assinar e verificar.
// Usa github.com/ProtonMail/go-crypto (BSD-3). Formato OpenPGP v4,
// chave Ed25519 + subchave Curve25519, legível por gpg, Kleopatra etc.

import (
	"bytes"
	"crypto"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/clearsign"
	pgperr "github.com/ProtonMail/go-crypto/openpgp/errors"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
)

var cfg = &packet.Config{
	Algorithm:       packet.PubKeyAlgoEdDSA,
	Curve:           packet.Curve25519,
	DefaultHash:     crypto.SHA512,
	V6Keys:          false,
	KeyLifetimeSecs: 0,
}

var ErrSenha = errors.New("Senha errada.")
var ErrTravada = errors.New("Digite a senha da chave primeiro.")
var ErrSemChave = errors.New("Crie ou importe sua chave primeiro.")

func armar(tipo string, f func(io.Writer) error) (string, error) {
	var b bytes.Buffer
	w, err := armor.Encode(&b, tipo, nil)
	if err != nil {
		return "", err
	}
	if err := f(w); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	return b.String() + "\n", nil
}

// GerarChave cria o par de chaves protegido pela senha.
// Devolve a chave secreta (cifrada), a pública e o certificado de revogação, em texto.
func GerarChave(nome, email, senha string) (priv, pub, rev string, err error) {
	nome = strings.TrimSpace(nome)
	email = strings.TrimSpace(email)
	if nome == "" {
		return "", "", "", errors.New("Coloque um nome.")
	}
	if strings.ContainsAny(nome+email, "()<>\x00") {
		return "", "", "", errors.New("O nome e o e-mail não podem ter ( ) < >.")
	}
	if len([]rune(senha)) < 8 {
		return "", "", "", errors.New("A senha precisa ter pelo menos 8 caracteres. Uma frase é melhor.")
	}
	e, err := openpgp.NewEntity(nome, "", email, cfg)
	if err != nil {
		return "", "", "", err
	}
	pub, err = armar(openpgp.PublicKeyType, e.Serialize)
	if err != nil {
		return
	}
	rev, err = certificadoRevogacao(e)
	if err != nil {
		return
	}
	if err = e.EncryptPrivateKeys([]byte(senha), cfg); err != nil {
		return
	}
	priv, err = armar(openpgp.PrivateKeyType, func(w io.Writer) error { return e.SerializePrivateWithoutSigning(w, nil) })
	return
}

// certificadoRevogacao precisa da chave destravada. Não altera e.
func certificadoRevogacao(e *openpgp.Entity) (string, error) {
	sig := &packet.Signature{
		Version:           e.PrimaryKey.Version,
		SigType:           packet.SigTypeKeyRevocation,
		PubKeyAlgo:        e.PrimaryKey.PubKeyAlgo,
		Hash:              crypto.SHA512,
		CreationTime:      time.Now(),
		IssuerKeyId:       &e.PrimaryKey.KeyId,
		IssuerFingerprint: e.PrimaryKey.Fingerprint,
	}
	motivo := packet.KeyCompromised
	sig.RevocationReason = &motivo
	sig.RevocationReasonText = "Chave revogada pelo dono."
	if err := sig.RevokeKey(e.PrimaryKey, e.PrivateKey, cfg); err != nil {
		return "", err
	}
	return armar(openpgp.PublicKeyType, sig.Serialize)
}

func lerChaves(texto string) (openpgp.EntityList, error) {
	t := strings.TrimSpace(texto)
	if t == "" {
		return nil, errors.New("chave vazia")
	}
	if strings.Contains(t, "-----BEGIN PGP") {
		return openpgp.ReadArmoredKeyRing(strings.NewReader(t))
	}
	return openpgp.ReadKeyRing(strings.NewReader(t))
}

// LerSecreta lê uma chave secreta (do backup ou de outro programa) e devolve
// a entidade e a chave secreta reescrita em texto ASCII.
func LerSecreta(dados []byte) (*openpgp.Entity, string, error) {
	el, err := lerChaves(string(dados))
	if err != nil {
		return nil, "", fmt.Errorf("não consegui ler a chave: %v", err)
	}
	for _, e := range el {
		if e.PrivateKey != nil {
			if !e.PrivateKey.Encrypted {
				return nil, "", errors.New("essa chave secreta não tem senha. Coloque uma senha nela antes (no gpg: gpg --edit-key, passwd)")
			}
			p, err := armar(openpgp.PrivateKeyType, func(w io.Writer) error { return e.SerializePrivateWithoutSigning(w, nil) })
			return e, p, err
		}
	}
	return nil, "", errors.New("esse arquivo tem só a chave pública. Para assinar é preciso a chave secreta (o backup)")
}

func Destravar(e *openpgp.Entity, senha string) error {
	if e.PrivateKey == nil {
		return ErrSemChave
	}
	if !e.PrivateKey.Encrypted {
		return nil
	}
	if err := e.DecryptPrivateKeys([]byte(senha)); err != nil {
		return ErrSenha
	}
	return nil
}

func PublicaDe(e *openpgp.Entity) (string, error) {
	return armar(openpgp.PublicKeyType, e.Serialize)
}

func NomeDe(e *openpgp.Entity) string {
	if id := e.PrimaryIdentity(); id != nil {
		return id.Name
	}
	for n := range e.Identities {
		return n
	}
	return "(sem nome)"
}

func Impressao(fp []byte) string {
	h := strings.ToUpper(fmt.Sprintf("%x", fp))
	var g []string
	for i := 0; i < len(h); i += 4 {
		j := i + 4
		if j > len(h) {
			j = len(h)
		}
		g = append(g, h[i:j])
	}
	return strings.Join(g, " ")
}

func AssinarTexto(e *openpgp.Entity, texto string) (string, error) {
	var b bytes.Buffer
	w, err := clearsign.Encode(&b, e.PrivateKey, cfg)
	if err != nil {
		return "", err
	}
	if _, err := io.WriteString(w, texto); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	return b.String(), nil
}

// AssinarArquivo grava "arquivo.ext.asc" ao lado do arquivo e devolve o caminho.
func AssinarArquivo(e *openpgp.Entity, caminho string) (string, error) {
	f, err := os.Open(caminho)
	if err != nil {
		return "", err
	}
	defer f.Close()
	var b bytes.Buffer
	if err := openpgp.ArmoredDetachSign(&b, e, f, cfg); err != nil {
		return "", err
	}
	b.WriteString("\n")
	destino := caminho + ".asc"
	if err := os.WriteFile(destino, b.Bytes(), 0o644); err != nil {
		return "", err
	}
	return destino, nil
}

type Resultado struct {
	Valida     bool   `json:"valida"`
	Quem       string `json:"quem"`
	Impressao  string `json:"impressao"`
	Data       string `json:"data"`
	Arquivo    string `json:"arquivo"`
	Assinatura string `json:"assinatura"`
	Motivo     string `json:"motivo"`
	EhDagDos   bool   `json:"ehDono"`
}

func dataBR(t time.Time) string {
	return t.Local().Format("02/01/2006 às 15:04")
}

func verificar(chaves openpgp.EntityList, dados io.Reader, assinatura []byte) Resultado {
	var sigR io.Reader = bytes.NewReader(assinatura)
	if bytes.Contains(assinatura, []byte("-----BEGIN PGP SIGNATURE-----")) {
		blk, err := armor.Decode(bytes.NewReader(assinatura))
		if err != nil {
			return Resultado{Motivo: "A assinatura está corrompida."}
		}
		sigR = blk.Body
	}
	sig, quem, err := openpgp.VerifyDetachedSignature(chaves, dados, sigR, nil)
	if err != nil {
		if errors.Is(err, pgperr.ErrUnknownIssuer) || strings.Contains(err.Error(), "signature made by unknown entity") {
			return Resultado{Motivo: "Essa assinatura foi feita por outra chave. Cole a chave pública de quem assinou."}
		}
		if strings.Contains(err.Error(), "expired") {
			return Resultado{Motivo: "A chave ou a assinatura venceu: " + err.Error()}
		}
		return Resultado{Motivo: "ASSINATURA INVÁLIDA. O conteúdo foi alterado ou não foi assinado por esta chave."}
	}
	r := Resultado{Valida: true, Quem: NomeDe(quem), Impressao: Impressao(quem.PrimaryKey.Fingerprint)}
	if sig != nil {
		r.Data = dataBR(sig.CreationTime)
	}
	if quem.Revoked(time.Now()) {
		r.Valida = false
		r.Motivo = "A assinatura confere, mas essa chave foi REVOGADA pelo dono. Não confie."
	}
	return r
}

func VerificarTexto(chaves openpgp.EntityList, texto string) Resultado {
	blk, _ := clearsign.Decode([]byte(strings.TrimSpace(texto) + "\n"))
	if blk == nil {
		return Resultado{Motivo: "Não achei um texto assinado. Ele começa com -----BEGIN PGP SIGNED MESSAGE-----"}
	}
	sigBody, err := io.ReadAll(blk.ArmoredSignature.Body)
	if err != nil {
		return Resultado{Motivo: "A assinatura está corrompida."}
	}
	return verificar(chaves, bytes.NewReader(blk.Bytes), sigBody)
}

// AcharAssinatura: dado um arquivo, acha a assinatura ao lado (.asc, .sig, .gpg).
// Se o próprio arquivo for a assinatura, acha o arquivo original.
func AcharPar(caminho string) (arquivo, assinatura string) {
	low := strings.ToLower(caminho)
	for _, ext := range []string{".asc", ".sig", ".gpg"} {
		if strings.HasSuffix(low, ext) {
			orig := caminho[:len(caminho)-len(ext)]
			if st, err := os.Stat(orig); err == nil && !st.IsDir() {
				return orig, caminho
			}
		}
	}
	for _, ext := range []string{".asc", ".sig", ".gpg"} {
		if _, err := os.Stat(caminho + ext); err == nil {
			return caminho, caminho + ext
		}
	}
	return caminho, ""
}

func VerificarArquivo(chaves openpgp.EntityList, arquivo, assinatura string) Resultado {
	sig, err := os.ReadFile(assinatura)
	if err != nil {
		return Resultado{Motivo: "Não consegui abrir a assinatura: " + err.Error()}
	}
	f, err := os.Open(arquivo)
	if err != nil {
		return Resultado{Motivo: "Não consegui abrir o arquivo: " + err.Error()}
	}
	defer f.Close()
	r := verificar(chaves, f, sig)
	r.Arquivo = filepath.Base(arquivo)
	r.Assinatura = filepath.Base(assinatura)
	return r
}
