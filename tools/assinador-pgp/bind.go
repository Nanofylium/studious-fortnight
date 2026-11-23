package main

import (
	_ "embed"
	"encoding/base64"
	"strings"
)

//go:embed ui/index.html
var paginaHTML string

//go:embed ui/logo.jpg
var logoJPG []byte

func pagina() string {
	return strings.Replace(paginaHTML, "{{LOGO}}", "data:image/jpeg;base64,"+base64.StdEncoding.EncodeToString(logoJPG), -1)
}

// ligacoes: nome no JavaScript -> função em Go.
func ligacoes(a *App) map[string]interface{} {
	return map[string]interface{}{
		"pgpEstado":                a.Estado,
		"pgpArgumentos":            a.Argumentos,
		"pgpGerarChave":            a.GerarChave,
		"pgpImportarChave":         a.ImportarChave,
		"pgpImportarTexto":         a.ImportarTexto,
		"pgpDestravar":             a.Destravar,
		"pgpTravar":                a.Travar,
		"pgpRemoverChave":          a.RemoverChave,
		"pgpChavePublica":          a.ChavePublica,
		"pgpExportar":              a.Exportar,
		"pgpAssinarTexto":          a.AssinarTexto,
		"pgpEscolherArquivos":      a.EscolherArquivos,
		"pgpAssinarCaminhos":       a.AssinarCaminhos,
		"pgpVerificarTexto":        a.VerificarTexto,
		"pgpEscolherParaVerificar": a.EscolherParaVerificar,
		"pgpVerificarCaminho":      a.VerificarCaminho,
		"pgpMostrarNaPasta":        a.MostrarNaPasta,
	}
}
