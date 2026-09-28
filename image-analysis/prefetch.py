"""Build-time: download all model weights into the image so runs never download anything."""
import os, torch, urllib.request
import open_clip, pyiqa
os.makedirs('/models', exist_ok=True)
open_clip.create_model_and_transforms('ViT-L-14', pretrained='openai', cache_dir='/models/clip')
open_clip.get_tokenizer('ViT-L-14')
# LAION "improved aesthetic predictor" head (sac+logos+ava1, linear MSE) that sits on CLIP ViT-L/14
url = 'https://github.com/christophschuhmann/improved-aesthetic-predictor/raw/main/sac%2Blogos%2Bava1-l14-linearMSE.pth'
urllib.request.urlretrieve(url, '/models/laion_aesthetic_l14.pth')
for name in ('topiq_nr', 'nima'):
    pyiqa.create_metric(name, device=torch.device('cpu'))
print('models ready')
