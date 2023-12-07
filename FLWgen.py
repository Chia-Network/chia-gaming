#!/usr/bin/env python3
# License: Apache-2.0
import json
from nltk.corpus import wordnet
from better_profanity import profanity
from english_dictionary.scripts.read_pickle import get_dict
english_dict = get_dict()
### five-letter-words excluding proper-nouns, also excluding non-alpha (ex: punctuated.)
flwinendict = [x for x in english_dict if len(x)==5 and x[0].islower() and x.isalpha()]
flwinwordnet = [k for k in wordnet.words() if len(k)==5 and k[0].islower() and k.isalpha()]
print("len(flwinendict): ", len(flwinendict))
print("len(flwinwordnet): ", len(flwinwordnet))
uofd = list(set.union(set(flwinendict), set(flwinwordnet)))
uofd.sort()
print("len(uofd): ", len(uofd))
censoredlist = [w for w in uofd if not profanity.contains_profanity(w)]
censoredlist.sort() # Perhaps already sorted, I don't care.
print("len(censoredlist): ", len(censoredlist))
json_object = json.dumps(censoredlist, indent=4)
with open("krunkwords.json", "w") as outfile:
    outfile.write(json_object)
print("Done.")
