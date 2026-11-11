"""Turns an RVC v2 voice model (.pth, from Applio or the RVC WebUI) into the
three ONNX files the Forja "Minha voz (RVC)" panel loads:

  minha-voz.onnx    the voice (the .pth's generator, any of 32k/40k/48k)
  hubert_base.onnx  the content encoder (lj1995/VoiceConversionWebUI, MIT)
  rmvpe.onnx        the pitch tracker (same repository, MIT)

Usage (Colab or any machine with Python 3.10+, no GPU needed):

  pip install torch==2.5.1 transformers==4.49.0 onnx onnxruntime huggingface_hub
  python exportar_onnx.py minha-voz.pth saida/

The generator's code comes from the `rvc` package (RVC-Project, MIT), taken
without its dependencies: only its model classes are used. Its relative
attention casts lengths to Python ints, which freezes the exported graph at
the example length; the three methods below are the same arithmetic written
so the length stays symbolic, and the ONNX file then takes any duration.
"""
import os
import subprocess
import sys
import zipfile

import torch
import torch.nn.functional as F

OUT = sys.argv[2] if len(sys.argv) > 2 else 'saida'
PTH = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

# --- the rvc package (MIT), code only --------------------------------------
pkg = os.path.join(OUT, '_rvc')
if not os.path.isdir(os.path.join(pkg, 'rvc')):
    subprocess.check_call([sys.executable, '-m', 'pip', 'download', 'rvc==0.3.5', '--no-deps', '-d', pkg, '-q'])
    whl = next(f for f in os.listdir(pkg) if f.endswith('.whl'))
    zipfile.ZipFile(os.path.join(pkg, whl)).extractall(pkg)
sys.path.insert(0, pkg)
from rvc.lib.infer_pack import attentions  # noqa: E402
from rvc.lib.infer_pack.models_onnx import SynthesizerTrnMsNSFsidM  # noqa: E402


def _get_relative_embeddings(self, relative_embeddings, length):
    # Needs length > window_size (true for any window the Forja sends).
    pad = length - (self.window_size + 1)
    padded = F.pad(relative_embeddings, [0, 0, pad, pad, 0, 0])
    return padded[:, 0 : 2 * length - 1]


def _relative_position_to_absolute_position(self, x):
    batch, heads, length, _ = x.size()
    x = F.pad(x, [0, 1, 0, 0, 0, 0, 0, 0])
    x_flat = x.view([batch, heads, length * 2 * length])
    x_flat = F.pad(x_flat, [0, length - 1, 0, 0, 0, 0])
    return x_flat.view([batch, heads, length + 1, 2 * length - 1])[:, :, :length, length - 1 :]


def _absolute_position_to_relative_position(self, x):
    batch, heads, length, _ = x.size()
    x = F.pad(x, [0, length - 1, 0, 0, 0, 0, 0, 0])
    x_flat = x.view([batch, heads, length * length + length * (length - 1)])
    x_flat = F.pad(x_flat, [length, 0, 0, 0, 0, 0])
    return x_flat.view([batch, heads, length, 2 * length])[:, :, :, 1:]


attentions.MultiHeadAttention._get_relative_embeddings = _get_relative_embeddings
attentions.MultiHeadAttention._relative_position_to_absolute_position = _relative_position_to_absolute_position
attentions.MultiHeadAttention._absolute_position_to_relative_position = _absolute_position_to_relative_position

# --- the voice --------------------------------------------------------------
cpt = torch.load(PTH, map_location='cpu', weights_only=True)  # tensors and numbers only
if cpt.get('version', 'v1') != 'v2' or not cpt.get('f0', 1):
    sys.exit('Use um modelo RVC v2 com pitch (f0), treinado com RMVPE.')
if cpt.get('vocoder', 'HiFi-GAN') != 'HiFi-GAN':
    sys.exit('Treine com o vocoder HiFi-GAN (o padrão do Applio).')
if cpt.get('embedder_model', 'contentvec') != 'contentvec':
    sys.exit('Treine com o embedder contentvec (o padrão do Applio).')
cfg = list(cpt['config'])
cfg[-3] = cpt['weight']['emb_g.weight'].shape[0]
net = SynthesizerTrnMsNSFsidM(*cfg, is_half=False, version='v2').eval()
net.load_state_dict({k: v.float() for k, v in cpt['weight'].items()}, strict=False)
T = 200
example = (
    torch.rand(1, T, 768),
    torch.tensor([T]).long(),
    torch.randint(5, 255, (1, T)),
    torch.rand(1, T) * 300,
    torch.LongTensor([0]),
    torch.rand(1, 192, T),
)
name = os.path.splitext(os.path.basename(PTH))[0] + '.onnx'
torch.onnx.export(
    net, example, os.path.join(OUT, name),
    input_names=['phone', 'phone_lengths', 'pitch', 'pitchf', 'ds', 'rnd'], output_names=['audio'],
    dynamic_axes={'phone': [1], 'pitch': [1], 'pitchf': [1], 'rnd': [2]},
    do_constant_folding=False, opset_version=13,
)
print('voz:', name, cfg[-1], 'Hz')

# --- the base networks (MIT, lj1995/VoiceConversionWebUI) -------------------
from huggingface_hub import hf_hub_download  # noqa: E402
from transformers import HubertModel  # noqa: E402

REPO = 'lj1995/VoiceConversionWebUI'
if not os.path.exists(os.path.join(OUT, 'rmvpe.onnx')):
    os.replace(hf_hub_download(REPO, 'rmvpe.onnx'), os.path.join(OUT, 'rmvpe.onnx'))
if not os.path.exists(os.path.join(OUT, 'hubert_base.onnx')):
    hub_dir = os.path.join(OUT, '_hubert')
    os.makedirs(hub_dir, exist_ok=True)
    for src, dst in (('hubert_base/config.json', 'config.json'), ('hubert_base/pytorch_model.bin', 'pytorch_model.bin')):
        os.replace(hf_hub_download(REPO, src), os.path.join(hub_dir, dst))
    hub = HubertModel.from_pretrained(hub_dir, torch_dtype=torch.float32).eval()

    class Features(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, source):
            return self.m(source).last_hidden_state  # layer 12, 768 dims

    torch.onnx.export(
        Features(hub), (torch.randn(1, 16000),), os.path.join(OUT, 'hubert_base.onnx'),
        input_names=['source'], output_names=['feats'], dynamic_axes={'source': [1], 'feats': [1]}, opset_version=17,
    )
print('pronto:', sorted(f for f in os.listdir(OUT) if f.endswith('.onnx')))
