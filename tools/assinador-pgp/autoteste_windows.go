//go:build windows

package main

// Autoteste: "assinador.exe --autoteste PASTA" abre a janela de verdade,
// clica nos botões, preenche os diálogos nativos de arquivo sozinho e grava
// PASTA\resultado.json. Usado na CI do Windows; não mexe na chave do usuário.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

type autoteste struct {
	dir  string
	mu   sync.Mutex
	fila []string // respostas dos diálogos, em ordem
	w    webview2.WebView
}

func novoAutoteste(dir string) *autoteste {
	dir, _ = filepath.Abs(dir)
	_ = os.MkdirAll(dir, 0o755)
	os.Setenv("DAGDOS_PASTA", filepath.Join(dir, "dados"))
	t := &autoteste{dir: dir}
	_ = os.WriteFile(filepath.Join(dir, "álbum teste.zip"), []byte("PK conteudo de teste do zip \x00\x01\x02"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "capa.jpg"), []byte("\xff\xd8\xff jpeg de teste"), 0o644)
	t.fila = []string{
		filepath.Join(dir, "dag-dos-chave-publica.asc"), // 1. salvar chave pública
		filepath.Join(dir, "álbum teste.zip"),           // 2. escolher arquivos para assinar
		filepath.Join(dir, "álbum teste.zip"),           // 3. verificar arquivo
	}
	go func() {
		time.Sleep(120 * time.Second)
		t.falhar("tempo esgotado")
	}()
	return t
}

func (t *autoteste) gravar(v interface{}) {
	b, _ := json.MarshalIndent(v, "", "  ")
	_ = os.WriteFile(filepath.Join(t.dir, "resultado.json"), b, 0o644)
}

func (t *autoteste) log(m string) {
	f, err := os.OpenFile(filepath.Join(t.dir, "teste.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		f.WriteString(time.Now().Format("15:04:05.000") + " " + m + "\n")
		f.Close()
	}
}

func (t *autoteste) falhar(motivo string) {
	t.log("FALHOU: " + motivo)
	t.gravar(map[string]interface{}{"ok": false, "erro": motivo})
	os.Exit(2)
}

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	procEnumWindows              = user32.NewProc("EnumWindows")
	procEnumChildWindows         = user32.NewProc("EnumChildWindows")
	procGetClassNameW            = user32.NewProc("GetClassNameW")
	procGetDlgCtrlID             = user32.NewProc("GetDlgCtrlID")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procPostMessageW             = user32.NewProc("PostMessageW")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
)

func classe(h uintptr) string {
	b := make([]uint16, 256)
	procGetClassNameW.Call(h, uintptr(unsafe.Pointer(&b[0])), 256)
	return syscall.UTF16ToString(b)
}

func acharDialogo() uintptr {
	var achado uintptr
	pid := uint32(os.Getpid())
	cb := syscall.NewCallback(func(h, _ uintptr) uintptr {
		var p uint32
		procGetWindowThreadProcessId.Call(h, uintptr(unsafe.Pointer(&p)))
		if v, _, _ := procIsWindowVisible.Call(h); p == pid && v != 0 && classe(h) == "#32770" {
			achado = h
			return 0
		}
		return 1
	})
	procEnumWindows.Call(cb, 0)
	return achado
}

// campo "Nome do arquivo": controle de ID 1148 (cmb13) ou 1152 (edt1), ou o Edit dentro dele.
func acharCampoNome(dlg uintptr) uintptr {
	var combo, edit uintptr
	cb := syscall.NewCallback(func(h, _ uintptr) uintptr {
		id, _, _ := procGetDlgCtrlID.Call(h)
		if (id == 1148 || id == 1152) && combo == 0 {
			combo = h
		}
		return 1
	})
	procEnumChildWindows.Call(dlg, cb, 0)
	if combo == 0 {
		return 0
	}
	if classe(combo) == "Edit" {
		return combo
	}
	cb2 := syscall.NewCallback(func(h, _ uintptr) uintptr {
		if classe(h) == "Edit" {
			edit = h
			return 0
		}
		return 1
	})
	procEnumChildWindows.Call(combo, cb2, 0)
	return edit
}

const (
	wmSetText = 0x000C
	wmCommand = 0x0111
	idOK      = 1
)

// preencher espera o diálogo aparecer, escreve o caminho e aperta OK.
func (t *autoteste) preencher(caminho string) {
	go func() {
		for i := 0; i < 200; i++ {
			time.Sleep(100 * time.Millisecond)
			dlg := acharDialogo()
			if dlg == 0 {
				continue
			}
			t.log("diálogo achado")
			time.Sleep(400 * time.Millisecond)
			ed := acharCampoNome(dlg)
			if ed == 0 {
				t.log("campo do nome ainda não achado")
				continue
			}
			p, _ := syscall.UTF16PtrFromString(caminho)
			procSendMessageW.Call(ed, wmSetText, 0, uintptr(unsafe.Pointer(p)))
			procPostMessageW.Call(dlg, wmCommand, idOK, 0)
			t.log("preenchido: " + caminho)
			return
		}
		t.falhar("o diálogo de arquivo não apareceu: " + caminho)
	}()
}

const roteiroJS = `
(async function(){
  function $(id){return document.getElementById(id)}
  function esperar(f,ms){ms=ms||30000;var t0=Date.now();return new Promise(function(ok,no){(function v(){var r;try{r=f()}catch(e){}if(r)return ok(r);if(Date.now()-t0>ms)return no(new Error("esperou demais: "+f));setTimeout(v,100)})()})}
  var R={passos:[]};function P(m){R.passos.push(m);try{pgpTesteLog(m)}catch(e){}}
  P("script iniciou");
  try{
    await esperar(function(){return window.__pronto});
    P("pagina pronta");
    R.nomePadrao=$("gNome").value;
    $("gSenha").value="senha de teste longa";$("gSenha2").value="senha de teste longa";
    $("btnGerar").click();
    await esperar(function(){return !$("comChave").classList.contains("hide")});
    R.impressao=$("kFp").textContent;R.nome=$("kNome").textContent;
    P("chave gerada");
    $("btnPub").click();
    await esperar(function(){return /Salvo/.test($("kMsg").textContent)});
    P("chave publica salva pelo dialogo");
    document.querySelector('nav button[data-tab=assinar]').click();
    $("btnEscolher").click();
    await esperar(function(){return $("aLista").children.length>0});
    R.listaAssinatura=$("aLista").textContent;
    P("arquivo assinado pelo dialogo");
    var cam=await pgpArgumentos();
    var r2=await pgpAssinarCaminhos([TESTDIR+"\\capa.jpg"]);
    R.capa=r2[0];
    $("tEntrada").value="Dağ Döş — texto oficial.\nAcentuação: ção, é, ü.\n-- linha com traço";
    $("btnAssTexto").click();
    await esperar(function(){return $("tSaida").value.length>0});
    R.textoAssinado=$("tSaida").value;
    P("texto assinado");
    document.querySelector('nav button[data-tab=verificar]').click();
    $("btnVerArq").click();
    await esperar(function(){return /Assinado|INVÁLIDA|Não/.test($("vMsg").textContent)});
    R.verificarArquivo=$("vMsg").textContent;
    $("vTexto").value=R.textoAssinado;$("btnVerTexto").click();
    await esperar(function(){return /Assinado/.test($("vMsg").textContent)&&$("vMsg").textContent!==R.verificarArquivo});
    R.verificarTexto=$("vMsg").textContent;
    var adult=await pgpVerificarTexto(R.textoAssinado.replace("oficial","falso"),"");
    R.adulterado=adult;
    R.ok=/Dağ Döş/.test(R.verificarArquivo)&&/Dağ Döş/.test(R.verificarTexto)&&!adult.valida&&R.capa&&!R.capa.erro;
  }catch(e){R.ok=false;R.erro=String(e&&e.message||e)}
  await pgpTesteFim(JSON.stringify(R));
})();
`

func (t *autoteste) ligar(w webview2.WebView, plat *platWindows) {
	t.w = w
	plat.antes = func() {
		t.mu.Lock()
		defer t.mu.Unlock()
		if len(t.fila) == 0 {
			return
		}
		c := t.fila[0]
		t.log("vai abrir diálogo para " + c)
		t.fila = t.fila[1:]
		t.preencher(c)
	}
	_ = w.Bind("pgpTesteLog", func(m string) { t.log("js: " + m) })
	_ = w.Bind("pgpTesteFim", func(s string) {
		var v map[string]interface{}
		_ = json.Unmarshal([]byte(s), &v)
		t.gravar(v)
		go func() {
			time.Sleep(300 * time.Millisecond)
			w.Dispatch(func() { w.Terminate() })
		}()
	})
	dirJS, _ := json.Marshal(t.dir)
	w.Init("window.TESTDIR=" + string(dirJS) + ";window.addEventListener('DOMContentLoaded',function(){" + roteiroJS + "});")
}
