//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

func caixaErro(titulo, texto string) {
	t, _ := syscall.UTF16PtrFromString(titulo)
	m, _ := syscall.UTF16PtrFromString(texto)
	windows.MessageBox(0, m, t, windows.MB_ICONERROR|windows.MB_OK)
}

func main() {
	args := os.Args[1:]
	var teste *autoteste
	if len(args) >= 2 && args[0] == "--autoteste" {
		teste = novoAutoteste(args[1])
		args = nil
	}

	plat := &platWindows{}
	app := NovoApp(plat, args)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     teste != nil,
		AutoFocus: true,
		DataPath:  filepath.Join(pastaDados(), "webview"),
		WindowOptions: webview2.WindowOptions{
			Title:  "Assinador Dağ Döş",
			Width:  900,
			Height: 900,
			IconId: 1,
			Center: true,
		},
	})
	if w == nil {
		if teste != nil {
			teste.falhar("WebView2 não abriu")
		}
		caixaErro("Assinador Dağ Döş", "Este Windows não tem o Microsoft Edge WebView2.\n\nBaixe e instale (é grátis, da Microsoft):\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703\n\nDepois abra o assinador de novo.")
		os.Exit(1)
	}
	defer w.Destroy()
	plat.hwnd = func() uintptr { return uintptr(unsafe.Pointer(w.Window())) }

	for nome, f := range ligacoes(app) {
		if err := w.Bind(nome, f); err != nil {
			caixaErro("Assinador Dağ Döş", err.Error())
		}
	}
	if teste != nil {
		teste.ligar(w, plat)
	}
	w.SetHtml(pagina())
	w.Run()
}
