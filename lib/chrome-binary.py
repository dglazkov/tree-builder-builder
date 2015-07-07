#!/usr/bin/env python
import optparse
import sys
import os
import tempfile

CHROMIUM_BASE_URL = ('http://commondatastorage.googleapis.com'
                     '/chromium-browser-snapshots')
WEBKIT_BASE_URL = ('http://commondatastorage.googleapis.com'
                   '/chromium-webkit-snapshots')

class Dummy(object):
    def write(self, x):
        pass
    def flush(self):
        pass

def main():
    parser = optparse.OptionParser()
    choices = ['mac', 'mac64', 'win', 'win64', 'linux', 'linux64', 'linux-arm', 'chromeos']
    platforms = ['mac', 'linux', 'win', 'chromeos']

    parser.add_option('-a', '--archive', choices=choices, help='The platform archive to pull')
    parser.add_option('-v', '--version', type='str', help='A version you want to get')
    parser.add_option('-d', '--directory', type='str', help='Directory of your chromium checkout')
    parser.add_option('-l', '--blink',
                      action='store_true',
                      help='Use Blink instead of Chromium. ')

    (opts, args) = parser.parse_args()

    sys.path.insert(0, opts.directory + '/tools')
    # TODO: Find a good place to put the binary zip files
    os.chdir(opts.directory + '/tools')

    # Python does not like filenames with hyphens
    build = __import__('bisect-builds')

    if opts.blink:
        base_url = WEBKIT_BASE_URL
    else:
        base_url = CHROMIUM_BASE_URL

    context = build.PathContext(base_url, opts.archive, opts.version, opts.version,
                                 False, False, True)
    zip_file = os.path.join(os.getcwd(), '%s-%s' % (str(opts.version), context.archive_name))
    fetch = build.DownloadJob(context, 'fetch', opts.version, zip_file)

    try:
        fetch.Start()
        save_stdout = sys.stdout
        sys.stdout = Dummy()
        fetch.WaitFor()
        sys.stdout = save_stdout
    except:
        sys.stderr.write('Saving chromium zipfile to %s' % (zip_file))
        sys.stderr.flush()
        return 1

    try:
        temp_dir = tempfile.mkdtemp(prefix='chrome_binary_')
        build.UnzipFilenameToDir(zip_file, temp_dir)
    except:
        sys.stderr.write('Bad Zip file at %s\n' % (zip_file))
        sys.stderr.write('Are you sure the version number %s is correct?' % (opts.version))
        sys.stderr.flush()
        return 1

    platform = [x for x in platforms if x in opts.archive][0]

    sys.stdout.write('%s/chrome-%s/chrome' % (temp_dir, platform))
    return 0

if __name__ == '__main__':
    sys.exit(main())
