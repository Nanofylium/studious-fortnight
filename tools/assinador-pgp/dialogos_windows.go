//go:build windows

package main

// Diálogos nativos do Windows (abrir/salvar arquivo) via comdlg32.

import (
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	comdlg32             = windows.NewLazySystemDLL("comdlg32.dll")
	procGetOpenFileNameW = comdlg32.NewProc("GetOpenFileNameW")
	procGetSaveFileNameW = comdlg32.NewProc("GetSaveFileNameW")
)

type openfilenameW struct {
	lStructSize       uint32
	hwndOwner         uintptr
	hInstance         uintptr
	lpstrFilter       *uint16
	lpstrCustomFilter *uint16
	nMaxCustFilter    uint32
	nFilterIndex      uint32
	lpstrFile         *uint16
	nMaxFile          uint32
	lpstrFileTitle    *uint16
	nMaxFileTitle     uint32
	lpstrInitialDir   *uint16
	lpstrTitle        *uint16
	flags             uint32
	nFileOffset       uint16
	nFileExtension    uint16
	lpstrDefExt       *uint16
	lCustData         uintptr
	lpfnHook          uintptr
	lpTemplateName    *uint16
	pvReserved        uintptr
	dwReserved        uint32
	flagsEx           uint32
}

const (
	ofnOverwritePrompt  = 0x00000002
	ofnHideReadOnly     = 0x00000004
	ofnNoChangeDir      = 0x00000008
	ofnAllowMultiSelect = 0x00000200
	ofnPathMustExist    = 0x00000800
	ofnFileMustExist    = 0x00001000
	ofnExplorer         = 0x00080000
	ofnLongNames        = 0x00200000
)

// filtro: pares "descrição|padrão" separados por "|".
func filtroW(tipo string) []uint16 {
	var f string
	switch tipo {
	case "chave":
		f = "Chaves PGP (*.asc, *.gpg, *.key)\x00*.asc;*.gpg;*.key;*.txt\x00Todos os arquivos\x00*.*\x00\x00"
	case "assinatura":
		f = "Assinaturas (*.asc, *.sig)\x00*.asc;*.sig;*.gpg\x00Todos os arquivos\x00*.*\x00\x00"
	case "asc":
		f = "Arquivo PGP (*.asc)\x00*.asc\x00Todos os arquivos\x00*.*\x00\x00"
	default:
		f = "Todos os arquivos\x00*.*\x00\x00"
	}
	return utf16.Encode([]rune(f))
}

type platWindows struct {
	hwnd func() uintptr
	// antes de abrir um diálogo (usado só no autoteste)
	antes func()
}

func (p *platWindows) owner() uintptr {
	if p.hwnd == nil {
		return 0
	}
	return p.hwnd()
}

func (p *platWindows) AbrirArquivos(titulo string, varios bool, filtro string) []string {
	if p.antes != nil {
		p.antes()
	}
	buf := make([]uint16, 1<<16)
	t, _ := syscall.UTF16PtrFromString(titulo)
	fl := filtroW(filtro)
	o := openfilenameW{
		hwndOwner:   p.owner(),
		lpstrFilter: &fl[0],
		lpstrFile:   &buf[0],
		nMaxFile:    uint32(len(buf)),
		lpstrTitle:  t,
		flags:       ofnExplorer | ofnFileMustExist | ofnPathMustExist | ofnNoChangeDir | ofnHideReadOnly | ofnLongNames,
	}
	if varios {
		o.flags |= ofnAllowMultiSelect
	}
	o.lStructSize = uint32(unsafe.Sizeof(o))
	r, _, _ := procGetOpenFileNameW.Call(uintptr(unsafe.Pointer(&o)))
	if r == 0 {
		return nil
	}
	// resultado: "pasta\0arq1\0arq2\0\0" ou "caminho completo\0\0"
	var partes []string
	ini := 0
	for i := 0; i < len(buf); i++ {
		if buf[i] == 0 {
			if i == ini {
				break
			}
			partes = append(partes, syscall.UTF16ToString(buf[ini:i]))
			ini = i + 1
		}
	}
	if len(partes) <= 1 {
		return partes
	}
	var out []string
	for _, n := range partes[1:] {
		out = append(out, filepath.Join(partes[0], n))
	}
	return out
}

func (p *platWindows) SalvarComo(titulo, nomePadrao string) string {
	if p.antes != nil {
		p.antes()
	}
	buf := make([]uint16, 4096)
	copy(buf, syscall.StringToUTF16(nomePadrao))
	t, _ := syscall.UTF16PtrFromString(titulo)
	ext, _ := syscall.UTF16PtrFromString("asc")
	fl := filtroW("asc")
	o := openfilenameW{
		hwndOwner:   p.owner(),
		lpstrFilter: &fl[0],
		lpstrFile:   &buf[0],
		nMaxFile:    uint32(len(buf)),
		lpstrTitle:  t,
		lpstrDefExt: ext,
		flags:       ofnExplorer | ofnOverwritePrompt | ofnPathMustExist | ofnNoChangeDir | ofnHideReadOnly | ofnLongNames,
	}
	o.lStructSize = uint32(unsafe.Sizeof(o))
	r, _, _ := procGetSaveFileNameW.Call(uintptr(unsafe.Pointer(&o)))
	if r == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

func (p *platWindows) MostrarNaPasta(caminho string) {
	c := exec.Command("explorer.exe")
	c.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + strings.ReplaceAll(caminho, `"`, "") + `"`}
	_ = c.Start()
}
