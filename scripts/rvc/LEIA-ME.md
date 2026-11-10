# Minha voz (RVC)

O painel **Minha voz (RVC)** da versão completa do Forja troca o timbre de um
vocal pelo da sua voz. Letra, melodia e interpretação continuam as do vocal
original. Usa o RVC (RVC-Project, licença MIT) e roda no seu computador.

O modelo da voz é treinado **só com as suas gravações** e fica com você: não
vai para o repositório nem para o instalador público.

## 1. Gravar

- 10 a 20 minutos da sua voz cantando, seca: sem instrumental, sem reverb, sem
  autotune, num lugar silencioso.
- Pode ser em várias partes (as letras das suas músicas servem bem). Cante na
  sua extensão confortável, com notas graves e agudas.
- WAV ou FLAC. Dá para gravar no editor do Forja ("Editar e gravar").

## 2. Treinar (Applio, MIT, no Google Colab)

1. Abra o Applio no Colab:
   https://colab.research.google.com/github/iahispano/applio/blob/main/assets/Applio.ipynb
   e escolha uma GPU em *Ambiente de execução → Alterar o tipo*.
2. Rode as células e abra a interface. Na aba **Train**:
   - Nome do modelo: por exemplo `minha-voz`.
   - Sample rate **40k**, f0 **rmvpe**, embedder **contentvec**, vocoder
     **HiFi-GAN** (são os padrões; o Forja precisa destes).
   - Envie as gravações, rode *Preprocess* e *Extract*, depois *Train* com
     cerca de 300 épocas (save a cada 50).
3. Baixe o arquivo `minha-voz.pth` (pasta `logs/minha-voz`, o de nome curto,
   sem `G_` nem `D_`). O `.index` não é usado.

## 3. Converter para o Forja

No mesmo Colab (ou em qualquer computador com Python 3.10+, sem GPU):

```
pip install torch==2.5.1 transformers==4.49.0 onnx onnxruntime huggingface_hub
python exportar_onnx.py minha-voz.pth saida/
```

Saem três arquivos em `saida/`: `minha-voz.onnx` (a sua voz),
`hubert_base.onnx` e `rmvpe.onnx` (as redes de base do RVC, MIT).

## 4. Usar no Forja

1. Abra a versão completa (senha) e carregue os stems da música.
2. No painel **Minha voz (RVC)**, clique em *Escolher arquivos .onnx* e
   selecione os três de uma vez. Ficam guardados no computador.
3. Ajuste o **Tom**: 0 se a Suno cantou na sua região; −12 se cantou uma
   oitava acima (voz feminina, por exemplo).
4. *Converter*. O resultado entra como o stem "Minha voz (...)" e o vocal
   original fica mudo, para comparar e voltar atrás.

Quanto mais limpo o vocal de entrada (stem de voz da Suno, sem eco), melhor o
resultado.
