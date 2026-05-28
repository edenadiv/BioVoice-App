---
license: cc-by-4.0
language:
- en
pipeline_tag: summarization
tags:
- speaker embedding
- wespeaker
- speaker modelling
---


Official model provided by [Wespeaker](https://github.com/wenet-e2e/wespeaker) project, ResNet293 based r-vector (After large margin finetune)

The model is trained on VoxCeleb2 Dev dataset, containing 5994 speakers.

## Model Sources

<!-- Provide the basic links for the model. -->

- **Repository:** https://github.com/wenet-e2e/wespeaker
- **Paper:** https://arxiv.org/pdf/2210.17016.pdf
- **Demo:** https://huggingface.co/spaces/wenet/wespeaker_demo


## Results on VoxCeleb
| Model | Params | Flops | LM | AS-Norm | vox1-O-clean | vox1-E-clean | vox1-H-clean |
|:------|:------:|:------|:--:|:-------:|:------------:|:------------:|:------------:|
| ResNet293-TSTP-emb256 | 28.62M | 28.10G | × | × | 0.595 | 0.756 | 1.433 |
|                       |        |        | × | √ | 0.537 | 0.701 | 1.276 |
|                       |        |        | √ | × | 0.532 | 0.707 | 1.311 |
|                       |        |        | √ | √ | **0.447** | **0.657** | **1.183** |

## Install Wespeaker

``` sh
pip install git+https://github.com/wenet-e2e/wespeaker.git
```

for development install:

``` sh
git clone https://github.com/wenet-e2e/wespeaker.git
cd wespeaker
pip install -e .
```


### Command line Usage

``` sh
$ wespeaker -p resnet293_download_dir --task embedding --audio_file audio.wav --output_file embedding.txt
$ wespeaker -p resnet293_download_dir --task embedding_kaldi --wav_scp wav.scp --output_file /path/to/embedding
$ wespeaker -p resnet293_download_dir --task similarity --audio_file audio.wav --audio_file2 audio2.wav
$ wespeaker -p resnet293_download_dir --task diarization --audio_file audio.wav
```

### Python Programming Usage

``` python
import wespeaker

model = wespeaker.load_model_local(resnet293_download_dir)
# set_gpu to enable the cuda inference, number < 0 means using CPU
model.set_gpu(0)

# embedding/embedding_kaldi/similarity/diarization
embedding = model.extract_embedding('audio.wav')
utt_names, embeddings = model.extract_embedding_list('wav.scp')
similarity = model.compute_similarity('audio1.wav', 'audio2.wav')
diar_result = model.diarize('audio.wav')

# register and recognize
model.register('spk1', 'spk1_audio1.wav')
model.register('spk2', 'spk2_audio1.wav')
model.register('spk3', 'spk3_audio1.wav')
result = model.recognize('spk1_audio2.wav')
```

## Citation
```bibtex
@inproceedings{wang2023wespeaker,
  title={Wespeaker: A research and production oriented speaker embedding learning toolkit},
  author={Wang, Hongji and Liang, Chengdong and Wang, Shuai and Chen, Zhengyang and Zhang, Binbin and Xiang, Xu and Deng, Yanlei and Qian, Yanmin},
  booktitle={IEEE International Conference on Acoustics, Speech and Signal Processing (ICASSP)},
  pages={1--5},
  year={2023},
  organization={IEEE}
}
```
