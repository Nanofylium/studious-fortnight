# Assinador Dağ Döş

Programa para Windows que assina qualquer arquivo ou texto com PGP (OpenPGP, chave Ed25519), legível por gpg, Kleopatra e GPG Suite. A chave secreta fica só no computador do usuário (em `%APPDATA%\Dag Dos Assinador`, protegida pela senha).

- Núcleo PGP: `core.go`, com [ProtonMail/go-crypto](https://github.com/ProtonMail/go-crypto) (BSD-3).
- Janela: `ui/index.html` dentro do WebView2 ([jchv/go-webview2](https://github.com/jchv/go-webview2), MIT). Sem CGO.
- Diálogos nativos de arquivo: `dialogos_windows.go`.

## Compilar (de qualquer sistema)

```
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w -buildid=" -o Assinador-DagDos.exe .
```

O ícone e o manifesto estão em `rsrc_windows_amd64.syso`. Para refazer: `go run github.com/tc-hib/go-winres@v0.3.3 make --in winres/winres.json --arch amd64`.

## Testar

- Windows: `Assinador-DagDos.exe --autoteste PASTA` abre a janela, clica nos botões, preenche os diálogos sozinho e grava `PASTA\resultado.json`. A CI (`.github/workflows/assinador-pgp.yml`) faz isso e confere as assinaturas com o gpg.
- Linux/Mac: `go run .` abre a mesma interface em `http://127.0.0.1:8765` (modo de desenvolvimento, diálogos simulados).
