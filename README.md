# Forja — studio mastering para stems

Arraste os stems gerados no Suno (voz, bateria, baixo...) ou uma faixa pronta.
O Forja repara estalos e buracos, tira o som metálico, mixa os stems e
masteriza no volume certo. Todo o processamento roda na sua máquina.

## Editar e gravar

A aba **Editar e gravar** é um editor multipistas (waveform-playlist, MIT):
os stems viram pistas, dá para mover, aparar, cortar (S), fazer fades,
desfazer, e gravar a voz pelo microfone com o resto tocando (R). **Usar na
mixagem** devolve as pistas como stems para a mixagem e o master do Forja.
Numa sessão vazia, "grave sua voz do zero" abre o editor direto.

## App de desktop

Instaladores prontos: aba **Actions** do GitHub, workflow **Desktop app**,
última execução, seção *Artifacts* (`Forja-Windows`, `Forja-macOS`,
`Forja-Linux`). Uma tag `v*` publica os mesmos arquivos numa release.

Os builds não são assinados. No Windows, clique em "Mais informações" e
"Executar assim mesmo"; no macOS, clique com o botão direito no app e
escolha "Abrir" na primeira vez.

Duas edições saem de cada build:

- **Pública** (`Forja-Setup.exe`, a do site do artista): reparo, mix, separação
  por IA, EQ, referência e master. Os recursos do dono não estão nela.
- **Completa** (`Forja-Completo-Setup.exe`, só como artifact
  `Forja-Windows-completo` da Action): tudo, com os recursos do dono trancados
  por senha.

Link fixo do instalador público (sempre a última release). Para publicar
uma versão: push de uma tag `v*`, ou rode o workflow **Desktop app** à mão
com o campo *release* preenchido (ex.: `v0.1.1`).

https://github.com/Nanofylium/studious-fortnight/releases/latest/download/Forja-Setup.exe

Para rodar a partir do código:

```bash
npm install
npm run desktop        # gera o build e abre a janela
npm run dist:desktop   # gera o instalador do seu sistema em release/
npm run dist:desktop:public   # o mesmo, edição pública
```

## Web (Base44)

```bash
npm install
npm run dev
```

## Verificações

```bash
npm test && npm run lint && npm run build
```
