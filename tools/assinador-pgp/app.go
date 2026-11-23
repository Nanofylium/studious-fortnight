package main

// Funções que a janela chama (window.nome(...) no JavaScript).

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/ProtonMail/go-crypto/openpgp"
)

// Plataforma: diálogos nativos (Windows) ou de teste.
type Plataforma interface {
	AbrirArquivos(titulo string, varios bool, filtro string) []string
	SalvarComo(titulo, nomePadrao string) string
	MostrarNaPasta(caminho string)
}

type App struct {
	mu      sync.Mutex
	pasta   string
	plat    Plataforma
	chave   *openpgp.Entity
	aberta  bool
	inicial []string
}

type Estado struct {
	TemChave   bool   `json:"temChave"`
	Nome       string `json:"nome"`
	Impressao  string `json:"impressao"`
	Criada     string `json:"criada"`
	Destravada bool   `json:"destravada"`
	Pasta      string `json:"pasta"`
	TemRevog   bool   `json:"temRevogacao"`
}

const (
	arqSecreta = "chave-secreta.asc"
	arqPublica = "chave-publica.asc"
	arqRevog   = "revogacao.asc"
)

func pastaDados() string {
	if p := os.Getenv("DAGDOS_PASTA"); p != "" {
		return p
	}
	base, err := os.UserConfigDir()
	if err != nil {
		base = "."
	}
	return filepath.Join(base, "Dag Dos Assinador")
}

func NovoApp(plat Plataforma, args []string) *App {
	a := &App{pasta: pastaDados(), plat: plat, inicial: args}
	_ = os.MkdirAll(a.pasta, 0o700)
	if b, err := os.ReadFile(filepath.Join(a.pasta, arqSecreta)); err == nil {
		if e, _, err := LerSecreta(b); err == nil {
			a.chave = e
		}
	}
	return a
}

func (a *App) p(n string) string { return filepath.Join(a.pasta, n) }

func (a *App) estado() Estado {
	s := Estado{Pasta: a.pasta}
	if a.chave != nil {
		s.TemChave = true
		s.Nome = NomeDe(a.chave)
		s.Impressao = Impressao(a.chave.PrimaryKey.Fingerprint)
		s.Criada = dataBR(a.chave.PrimaryKey.CreationTime)
		s.Destravada = a.aberta
		_, err := os.Stat(a.p(arqRevog))
		s.TemRevog = err == nil
	}
	return s
}

func (a *App) Estado() Estado { a.mu.Lock(); defer a.mu.Unlock(); return a.estado() }

func (a *App) Argumentos() []string { return a.inicial }

func (a *App) GerarChave(nome, email, senha string) (Estado, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.chave != nil {
		return a.estado(), errors.New("Já existe uma chave. Remova a atual antes de criar outra.")
	}
	priv, pub, rev, err := GerarChave(nome, email, senha)
	if err != nil {
		return a.estado(), err
	}
	if err := os.WriteFile(a.p(arqSecreta), []byte(priv), 0o600); err != nil {
		return a.estado(), err
	}
	_ = os.WriteFile(a.p(arqPublica), []byte(pub), 0o644)
	_ = os.WriteFile(a.p(arqRevog), []byte(rev), 0o600)
	e, _, err := LerSecreta([]byte(priv))
	if err != nil {
		return a.estado(), err
	}
	a.chave = e
	a.aberta = false
	if Destravar(a.chave, senha) == nil {
		a.aberta = true
	}
	return a.estado(), nil
}

func (a *App) importar(dados []byte) (Estado, error) {
	e, priv, err := LerSecreta(dados)
	if err != nil {
		return a.estado(), err
	}
	if err := os.WriteFile(a.p(arqSecreta), []byte(priv), 0o600); err != nil {
		return a.estado(), err
	}
	pub, _ := PublicaDe(e)
	_ = os.WriteFile(a.p(arqPublica), []byte(pub), 0o644)
	_ = os.Remove(a.p(arqRevog))
	a.chave, a.aberta = e, false
	return a.estado(), nil
}

func (a *App) ImportarChave() (Estado, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	fs := a.plat.AbrirArquivos("Abrir o backup da chave secreta", false, "chave")
	if len(fs) == 0 {
		return a.estado(), nil
	}
	b, err := os.ReadFile(fs[0])
	if err != nil {
		return a.estado(), err
	}
	return a.importar(b)
}

func (a *App) ImportarTexto(t string) (Estado, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.importar([]byte(t))
}

func (a *App) Destravar(senha string) (Estado, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.chave == nil {
		return a.estado(), ErrSemChave
	}
	if senha == "" {
		return a.estado(), ErrTravada
	}
	// relê do disco para nunca misturar com uma cópia já aberta
	b, err := os.ReadFile(a.p(arqSecreta))
	if err != nil {
		return a.estado(), err
	}
	e, _, err := LerSecreta(b)
	if err != nil {
		return a.estado(), err
	}
	if err := Destravar(e, senha); err != nil {
		return a.estado(), err
	}
	a.chave, a.aberta = e, true
	if _, err := os.Stat(a.p(arqRevog)); err != nil {
		if rev, err := certificadoRevogacao(e); err == nil {
			_ = os.WriteFile(a.p(arqRevog), []byte(rev), 0o600)
		}
	}
	return a.estado(), nil
}

func (a *App) Travar() Estado {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.chave != nil && a.aberta {
		if b, err := os.ReadFile(a.p(arqSecreta)); err == nil {
			if e, _, err := LerSecreta(b); err == nil {
				a.chave = e
			}
		}
	}
	a.aberta = false
	return a.estado()
}

func (a *App) RemoverChave() Estado {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, n := range []string{arqSecreta, arqPublica, arqRevog} {
		_ = os.Remove(a.p(n))
	}
	a.chave, a.aberta = nil, false
	return a.estado()
}

func (a *App) ChavePublica() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.chave == nil {
		return "", ErrSemChave
	}
	return PublicaDe(a.chave)
}

func copiar(origem, destino string) error {
	b, err := os.ReadFile(origem)
	if err != nil {
		return err
	}
	return os.WriteFile(destino, b, 0o644)
}

// Exportar: qual = "publica" | "secreta" | "revogacao". Devolve o caminho salvo ("" se cancelou).
func (a *App) Exportar(qual string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.chave == nil {
		return "", ErrSemChave
	}
	var origem, nome, titulo string
	switch qual {
	case "publica":
		pub, err := PublicaDe(a.chave)
		if err != nil {
			return "", err
		}
		_ = os.WriteFile(a.p(arqPublica), []byte(pub), 0o644)
		origem, nome, titulo = arqPublica, "dag-dos-chave-publica.asc", "Salvar a chave pública (para o site)"
	case "secreta":
		origem, nome, titulo = arqSecreta, "dag-dos-chave-SECRETA-backup.asc", "Salvar o backup da chave secreta"
	case "revogacao":
		origem, nome, titulo = arqRevog, "dag-dos-revogacao.asc", "Salvar o certificado de revogação"
		if _, err := os.Stat(a.p(arqRevog)); err != nil {
			return "", errors.New("Digite a senha (em Assinar) uma vez para criar o certificado de revogação.")
		}
	default:
		return "", errors.New("pedido desconhecido")
	}
	destino := a.plat.SalvarComo(titulo, nome)
	if destino == "" {
		return "", nil
	}
	if err := copiar(a.p(origem), destino); err != nil {
		return "", err
	}
	return destino, nil
}

func (a *App) AssinarTexto(texto string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.chave == nil {
		return "", ErrSemChave
	}
	if !a.aberta {
		return "", ErrTravada
	}
	if strings.TrimSpace(texto) == "" {
		return "", errors.New("Escreva o texto primeiro.")
	}
	return AssinarTexto(a.chave, texto)
}

type Assinado struct {
	Arquivo    string `json:"arquivo"`
	Caminho    string `json:"caminho"`
	Assinatura string `json:"assinatura"`
	Erro       string `json:"erro"`
}

func (a *App) AssinarCaminhos(caminhos []string) ([]Assinado, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.chave == nil {
		return nil, ErrSemChave
	}
	if !a.aberta {
		return nil, ErrTravada
	}
	var out []Assinado
	for _, c := range caminhos {
		r := Assinado{Arquivo: filepath.Base(c), Caminho: c}
		if st, err := os.Stat(c); err != nil || st.IsDir() {
			r.Erro = "não é um arquivo"
		} else if dest, err := AssinarArquivo(a.chave, c); err != nil {
			r.Erro = err.Error()
		} else {
			r.Assinatura = filepath.Base(dest)
		}
		out = append(out, r)
	}
	return out, nil
}

func (a *App) EscolherArquivos() []string {
	return a.plat.AbrirArquivos("Escolha o que assinar", true, "")
}

func (a *App) chaves(extra string) (openpgp.EntityList, error) {
	var el openpgp.EntityList
	if strings.TrimSpace(extra) != "" {
		x, err := lerChaves(extra)
		if err != nil {
			return nil, errors.New("Não consegui ler a chave pública colada.")
		}
		el = append(el, x...)
	}
	if a.chave != nil {
		el = append(el, a.chave)
	}
	if len(el) == 0 {
		return nil, errors.New("Cole a chave pública de quem assinou (ou crie a sua).")
	}
	return el, nil
}

func (a *App) marcarDono(r Resultado) Resultado {
	if r.Valida && a.chave != nil && r.Impressao == Impressao(a.chave.PrimaryKey.Fingerprint) {
		r.EhDagDos = true
	}
	return r
}

func (a *App) VerificarTexto(texto, extra string) (Resultado, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	el, err := a.chaves(extra)
	if err != nil {
		return Resultado{}, err
	}
	return a.marcarDono(VerificarTexto(el, texto)), nil
}

// VerificarCaminho: o usuário escolhe o arquivo (ou o .asc); a assinatura ao lado é achada sozinha.
func (a *App) VerificarCaminho(caminho, extra string) (Resultado, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	el, err := a.chaves(extra)
	if err != nil {
		return Resultado{}, err
	}
	arq, sig := AcharPar(caminho)
	if sig == "" {
		fs := a.plat.AbrirArquivos("Não achei a assinatura ao lado. Escolha o .asc de "+filepath.Base(arq), false, "assinatura")
		if len(fs) == 0 {
			return Resultado{Motivo: "Sem a assinatura (.asc) não dá para verificar."}, nil
		}
		sig = fs[0]
	}
	return a.marcarDono(VerificarArquivo(el, arq, sig)), nil
}

func (a *App) EscolherParaVerificar() string {
	fs := a.plat.AbrirArquivos("Escolha o arquivo assinado (ou o .asc dele)", false, "")
	if len(fs) == 0 {
		return ""
	}
	return fs[0]
}

func (a *App) MostrarNaPasta(caminho string) { a.plat.MostrarNaPasta(caminho) }
